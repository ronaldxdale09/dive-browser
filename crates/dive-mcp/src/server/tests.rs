use serde_json::json;
#[test]
fn the_catalog_lists_every_tool_once_with_a_schema() {
    let catalog = tool_catalog();
    assert!(catalog.len() >= 30, "{}", catalog.len());
    let mut names: Vec<&str> = catalog.iter().map(|e| e.name.as_str()).collect();
    names.dedup();
    assert_eq!(names.len(), catalog.len());
    for entry in &catalog {
        assert!(
            !entry.description.is_empty(),
            "{} has no description",
            entry.name
        );
        assert_eq!(entry.input_schema["type"], "object", "{}", entry.name);
    }
    assert!(names.contains(&"page_click"));
    assert!(names.contains(&"tab_open"));
}

#[test]
fn an_argument_the_tool_does_not_declare_is_named_in_the_error() {
    let catalog = tool_catalog();
    let schema = |name: &str| {
        let entry = catalog
            .iter()
            .find(|e| e.name == name)
            .unwrap_or_else(|| panic!("{name} in catalog"));
        entry.input_schema.as_object().cloned().unwrap_or_default()
    };
    let args = |v: serde_json::Value| v.as_object().cloned();
    // `id` is the classic slip for `tab_id`; it must not fall back to the active tab.
    assert_eq!(
        super::unknown_arguments(&schema("tab_activate"), args(json!({"id": "x"})).as_ref()),
        vec!["id".to_owned()]
    );
    assert!(
        super::unknown_arguments(
            &schema("tab_activate"),
            args(json!({"tab_id": "x"})).as_ref()
        )
        .is_empty()
    );
    assert!(super::unknown_arguments(&schema("tab_activate"), None).is_empty());
    // Flattened locator fields count as declared.
    assert!(
        super::unknown_arguments(
            &schema("page_click"),
            args(json!({"tab_id": "x", "locator": "text=Go", "x": 1})).as_ref()
        )
        .is_empty()
    );
    assert_eq!(
        super::unknown_arguments(
            &schema("page_click"),
            args(json!({"selector": ".a"})).as_ref()
        ),
        vec!["selector".to_owned()]
    );
}

use std::sync::Mutex;

use async_trait::async_trait;

use super::*;
use crate::{
    Addressed, BrowserError, DEFAULT_WAIT_MS, MAX_LOCATOR_CHARS, TabInfo, Target, serve,
    tool_catalog,
};

#[derive(Default)]
struct Fake {
    tabs: Mutex<Vec<TabInfo>>,
    navigated: Mutex<Vec<(TabId, String)>>,
}

#[async_trait]
impl Browser for Fake {
    async fn tabs(&self) -> Result<Vec<TabInfo>, BrowserError> {
        Ok(self.tabs.lock().unwrap().clone())
    }
    async fn open_tab(&self, url: String) -> Result<TabInfo, BrowserError> {
        let t = TabInfo {
            id: TabId::new().to_string(),
            url,
            title: String::new(),
            active: true,
        };
        self.tabs.lock().unwrap().push(t.clone());
        Ok(t)
    }
    async fn navigate(&self, tab: TabId, url: String) -> Result<(), BrowserError> {
        self.navigated.lock().unwrap().push((tab, url));
        Ok(())
    }
    async fn close(&self, tab: TabId) -> Result<(), BrowserError> {
        let mut tabs = self.tabs.lock().unwrap();
        let before = tabs.len();
        tabs.retain(|t| t.id != tab.to_string());
        if tabs.len() == before {
            return Err(BrowserError::TabNotFound(tab.to_string()));
        }
        Ok(())
    }
    async fn activate(&self, tab: TabId) -> Result<(), BrowserError> {
        let mut tabs = self.tabs.lock().unwrap();
        if !tabs.iter().any(|t| t.id == tab.to_string()) {
            return Err(BrowserError::TabNotFound(tab.to_string()));
        }
        for t in tabs.iter_mut() {
            t.active = t.id == tab.to_string();
        }
        Ok(())
    }
    async fn page_text(&self, _tab: TabId) -> Result<String, BrowserError> {
        Ok("hello".into())
    }
    async fn page_markdown(&self, _tab: TabId) -> Result<String, BrowserError> {
        Ok("# hello".into())
    }
    async fn screenshot(&self, _tab: TabId, _full: bool) -> Result<Vec<u8>, BrowserError> {
        Ok(vec![1, 2, 3])
    }
    async fn evaluate(&self, _tab: TabId, expr: String) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({ "expr": expr }))
    }
    async fn console_tail(
        &self,
        _tab: TabId,
        limit: usize,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!([{ "text": "line", "limit": limit }]))
    }
    async fn requests(&self, _tab: TabId, limit: usize) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!([{ "url": "https://a.dev", "limit": limit }]))
    }
    async fn request_body(
        &self,
        _tab: TabId,
        request_id: String,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({ "request_id": request_id, "body": "{}" }))
    }
    async fn page_state(&self, _tab: TabId) -> Result<String, BrowserError> {
        Ok("- RootWebArea \"x\"\n".into())
    }
    async fn page_inspect(&self, _tab: TabId) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"url": "https://a.dev", "elements": []}))
    }
    async fn page_click(
        &self,
        _tab: TabId,
        target: Target,
    ) -> Result<serde_json::Value, BrowserError> {
        match target.resolve()? {
            Addressed::Ref(r) if r == "e1" => Ok(serde_json::json!({"clicked": "e1"})),
            Addressed::Ref(r) => Err(BrowserError::Other(format!("unknown ref {r}"))),
            Addressed::Locator(l) if l.contains("absent") => {
                Err(BrowserError::TargetNotFound { locator: l })
            }
            Addressed::Locator(l) => Ok(serde_json::json!({"clicked": l})),
            Addressed::Point { x, y } => Ok(serde_json::json!({"clicked": [x, y]})),
        }
    }
    async fn page_type(
        &self,
        _tab: TabId,
        target: Target,
        text: String,
        clear: bool,
        submit: bool,
    ) -> Result<serde_json::Value, BrowserError> {
        target.resolve()?;
        Ok(serde_json::json!({"typed": text, "clear": clear, "submit": submit}))
    }
    async fn page_press(
        &self,
        _tab: TabId,
        _target: Target,
        key: String,
        _modifiers: Vec<String>,
    ) -> Result<(), BrowserError> {
        if key.is_empty() {
            return Err(BrowserError::BadRequest("key is required".into()));
        }
        Ok(())
    }
    async fn page_scroll(
        &self,
        _tab: TabId,
        _target: Target,
        delta_x: f64,
        delta_y: f64,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"delta_x": delta_x, "delta_y": delta_y}))
    }
    async fn history(
        &self,
        _tab: TabId,
        action: String,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"action": action}))
    }

    async fn page_hover(
        &self,
        _tab: TabId,
        target: Target,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"hovered": target.locator}))
    }

    async fn page_select(
        &self,
        _tab: TabId,
        params: SelectParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"selected": params.value.or(params.label)}))
    }

    async fn page_dialog(
        &self,
        _tab: TabId,
        params: DialogParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"answered": params.accept.unwrap_or(true), "text": params.text}))
    }

    async fn page_wait_for(
        &self,
        _tab: TabId,
        params: WaitForParams,
    ) -> Result<serde_json::Value, BrowserError> {
        if params.locator.as_deref() == Some("text=never") {
            return Err(BrowserError::Timeout {
                operation: "page_wait_for".into(),
                timeout_ms: params.timeout_ms.unwrap_or(DEFAULT_WAIT_MS),
                detail: "locator never matched".into(),
            });
        }
        Ok(serde_json::json!({"matched": true}))
    }
    async fn page_locate(
        &self,
        _tab: TabId,
        locator: String,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"locator": locator, "matches": []}))
    }
    async fn page_resize(
        &self,
        _tab: TabId,
        params: ResizeParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"preset": params.preset, "reset": params.reset}))
    }
    async fn page_devices(&self) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!([{"id": "iphone-15"}]))
    }
    async fn page_appearance(
        &self,
        _tab: TabId,
        params: AppearanceParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"color_scheme": params.color_scheme}))
    }
    async fn page_throttle(
        &self,
        _tab: TabId,
        profile: String,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"profile": profile}))
    }
    async fn page_component(
        &self,
        _tab: TabId,
        _target: Target,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"component_name": "SubmitButton"}))
    }
    async fn dev_servers(&self) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!([{"port": 5173}]))
    }
    async fn api_spec(&self, _tab: TabId) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"openapi": "3.1.0"}))
    }
    async fn page_report(&self, _tab: TabId) -> Result<String, BrowserError> {
        Ok("## Bug report".into())
    }
    async fn rules(&self) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!([]))
    }
    async fn set_rules(&self, _rules: serde_json::Value) -> Result<(), BrowserError> {
        Ok(())
    }
    async fn page_snapshot(&self, _tab: TabId) -> Result<String, BrowserError> {
        Ok("snapshot".into())
    }
    async fn page_diff(&self, _tab: TabId) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"summary": "no differences"}))
    }

    async fn page_fill_form(
        &self,
        _tab: TabId,
        params: crate::params::FillFormParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"filled": params.fields.len()}))
    }

    async fn page_upload(
        &self,
        _tab: TabId,
        params: crate::params::UploadParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"files": params.paths.len()}))
    }

    async fn page_drag(
        &self,
        _tab: TabId,
        params: crate::params::DragParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"dragged": params.from, "onto": params.to}))
    }

    async fn page_storage_get(
        &self,
        _tab: TabId,
        _params: crate::params::StorageGetParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"cookies": [], "local": {}, "session": {}}))
    }

    async fn page_storage_set(
        &self,
        _tab: TabId,
        _params: crate::params::StorageSetParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"set": true}))
    }

    async fn page_storage_clear(
        &self,
        _tab: TabId,
        _params: crate::params::StorageClearParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"cleared": true}))
    }
}

#[test]
fn a_target_has_to_name_exactly_one_element() {
    let locator = Target::locator("role=button");
    assert_eq!(
        locator.resolve().unwrap(),
        Addressed::Locator("role=button".into())
    );

    // Whitespace around a locator is the caller being tidy, not a selector.
    assert_eq!(
        Target::locator("  text=Go  ").resolve().unwrap(),
        Addressed::Locator("text=Go".into())
    );

    let point = Target {
        x: Some(10.0),
        y: Some(20.0),
        ..Target::default()
    };
    assert_eq!(
        point.resolve().unwrap(),
        Addressed::Point { x: 10.0, y: 20.0 }
    );

    // Naming nothing, or two things at once, is a request error rather
    // than a silent choice of one of them.
    assert_eq!(
        Target::default().resolve().unwrap_err().code(),
        "bad_request"
    );
    let both = Target {
        locator: Some("text=Go".into()),
        r#ref: Some("e1".into()),
        ..Target::default()
    };
    assert_eq!(both.resolve().unwrap_err().code(), "bad_request");

    // A lone coordinate is a typo, not a click at y=0.
    let half = Target {
        x: Some(10.0),
        ..Target::default()
    };
    assert!(half.resolve().unwrap_err().to_string().contains("together"));

    // An empty locator is a selector problem, so it reads as one.
    assert_eq!(
        Target::locator("   ").resolve().unwrap_err().code(),
        "invalid_selector"
    );

    assert_eq!(
        Target::locator("x".repeat(MAX_LOCATOR_CHARS + 1))
            .resolve()
            .unwrap_err()
            .code(),
        "invalid_selector"
    );
    assert!(
        Target {
            x: Some(f64::INFINITY),
            y: Some(1.0),
            ..Target::default()
        }
        .resolve()
        .is_err()
    );
}

#[test]
fn errors_carry_a_code_a_retry_hint_and_the_locator() {
    let not_found = BrowserError::TargetNotFound {
        locator: "text=Go".into(),
    };
    assert_eq!(not_found.code(), "target_not_found");
    assert!(not_found.retryable(), "an element may still appear");
    assert_eq!(not_found.locator(), Some("text=Go"));

    let invalid = BrowserError::InvalidSelector {
        locator: "role=".into(),
        reason: "no role name".into(),
    };
    assert!(
        !invalid.retryable(),
        "an unparseable locator will not fix itself"
    );

    assert!(
        BrowserError::NotEnabled {
            locator: "text=Save".into()
        }
        .retryable()
    );
    assert!(
        !BrowserError::NotEditable {
            locator: "css=div".into()
        }
        .retryable()
    );
    assert!(!BrowserError::ResultTooLarge { bytes: 10, max: 5 }.retryable());

    // The tag and hint reach the caller in the error payload.
    let data = ErrorData::from(BrowserError::TargetNotFound {
        locator: "text=Go".into(),
    })
    .data
    .expect("errors carry structured data");
    assert_eq!(data["code"], "target_not_found");
    assert_eq!(data["retryable"], true);
    assert_eq!(data["locator"], "text=Go");
}

#[tokio::test]
async fn a_failed_click_reports_which_locator_missed() {
    let server = DiveServer::new(Arc::new(seeded_fake()), Config::default());
    let error = server
        .page_click(Parameters(ClickParams {
            tab_id: None,
            target: Target::locator("text=absent"),
        }))
        .await
        .expect_err("a locator that matches nothing is an error");
    assert!(error.message.contains("text=absent"), "{error:?}");
    assert_eq!(
        error.data.expect("structured data")["code"],
        "target_not_found"
    );
}

#[tokio::test]
async fn a_wait_that_times_out_says_what_it_was_waiting_for() {
    let server = DiveServer::new(Arc::new(seeded_fake()), Config::default());
    let error = server
        .page_wait_for(Parameters(WaitForParams {
            locator: Some("text=never".into()),
            ..WaitForParams::default()
        }))
        .await
        .expect_err("an unmet condition has to fail");
    assert!(error.message.contains("timed out"), "{error:?}");
    assert!(error.message.contains("never matched"), "{error:?}");
    assert_eq!(error.data.expect("structured data")["code"], "timeout");
}

#[tokio::test]
async fn a_blank_tab_id_means_the_active_tab() {
    let server = DiveServer::new(Arc::new(seeded_fake()), Config::default());
    let text = text_of(
        &server
            .page_text(Parameters(TabRef {
                tab_id: Some(String::new()),
            }))
            .await
            .expect("blank id falls back to the active tab"),
    );
    assert!(!text.is_empty());
    let error = server
        .page_text(Parameters(TabRef {
            tab_id: Some("nope".into()),
        }))
        .await
        .expect_err("a malformed id is refused");
    assert!(error.message.contains("tabs_list"), "{error:?}");
}

#[tokio::test]
async fn capabilities_report_the_grammar_and_whether_evaluate_is_on() {
    let closed = DiveServer::new(Arc::new(Fake::default()), Config::default());
    let reported: serde_json::Value =
        serde_json::from_str(&text_of(&closed.dive_capabilities().await.unwrap())).unwrap();
    assert_eq!(reported["evaluate_enabled"], false);
    assert!(
        reported["locator_grammar"]
            .as_str()
            .unwrap()
            .contains("role=button"),
        "callers learn the grammar from here rather than guessing"
    );

    let open = DiveServer::new(
        Arc::new(Fake::default()),
        Config {
            allow_evaluate: true,
            token: None,
        },
    );
    let reported: serde_json::Value =
        serde_json::from_str(&text_of(&open.dive_capabilities().await.unwrap())).unwrap();
    assert_eq!(reported["evaluate_enabled"], true);
}

/// A fake with one tab, so tab-scoped tools resolve without an explicit id.
fn seeded_fake() -> Fake {
    let fake = Fake::default();
    fake.tabs.lock().unwrap().push(TabInfo {
        id: TabId::new().to_string(),
        url: "https://a.dev".into(),
        title: "A".into(),
        active: true,
    });
    fake
}

fn text_of(r: &CallToolResult) -> String {
    r.content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect()
}

#[tokio::test]
async fn tools_round_trip_through_the_fake() {
    let fake = Arc::new(Fake::default());
    let server = DiveServer::new(fake.clone(), Config::default());

    let opened = server
        .tab_open(Parameters(OpenParams {
            url: "https://a.dev".into(),
        }))
        .await
        .unwrap();
    let tab: TabInfo = serde_json::from_str(&text_of(&opened)).unwrap();
    assert_eq!(tab.url, "https://a.dev");

    let listed = server.tabs_list().await.unwrap();
    assert!(text_of(&listed).contains("https://a.dev"));

    // No tab id resolves to the active tab.
    let text = server
        .page_text(Parameters(TabRef::default()))
        .await
        .unwrap();
    assert_eq!(text_of(&text), "hello");

    server
        .tab_navigate(Parameters(NavigateParams {
            tab_id: Some(tab.id.clone()),
            url: "https://b.dev".into(),
        }))
        .await
        .unwrap();
    assert_eq!(fake.navigated.lock().unwrap()[0].1, "https://b.dev");

    let shot = server
        .page_screenshot(Parameters(ScreenshotParams::default()))
        .await
        .unwrap();
    assert!(shot.content[0].as_image().is_some());

    let tail = server
        .console_tail(Parameters(TailParams {
            tab_id: None,
            limit: Some(5),
        }))
        .await
        .unwrap();
    assert!(text_of(&tail).contains("\"limit\": 5"));
    let reqs = server
        .network_list(Parameters(TailParams::default()))
        .await
        .unwrap();
    assert!(text_of(&reqs).contains("\"limit\": 50"));
}

#[tokio::test]
async fn only_http_urls_can_be_opened_or_navigated_to() {
    let fake = Arc::new(seeded_fake());
    let server = DiveServer::new(fake.clone(), Config::default());
    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,<script>1</script>",
        "chrome://settings",
        "ftp://a.dev/x",
    ] {
        let err = server
            .tab_open(Parameters(OpenParams { url: url.into() }))
            .await
            .expect_err(url);
        assert_eq!(
            err.data.as_ref().expect("structured data")["code"],
            "not_allowed"
        );
        assert!(err.message.contains("http"), "{err:?}");

        let err = server
            .tab_navigate(Parameters(NavigateParams {
                tab_id: None,
                url: url.into(),
            }))
            .await
            .expect_err(url);
        assert_eq!(
            err.data.as_ref().expect("structured data")["code"],
            "not_allowed"
        );
    }
    let err = server
        .tab_open(Parameters(OpenParams {
            url: "not a url".into(),
        }))
        .await
        .unwrap_err();
    assert_eq!(
        err.data.as_ref().expect("structured data")["code"],
        "bad_request"
    );

    // Nothing reached the browser.
    assert_eq!(fake.tabs.lock().unwrap().len(), 1);
    assert!(fake.navigated.lock().unwrap().is_empty());

    // http(s) and a blank page are fine.
    for url in ["http://localhost:5173/", "https://a.dev/", "about:blank"] {
        server
            .tab_open(Parameters(OpenParams { url: url.into() }))
            .await
            .expect(url);
        server
            .tab_navigate(Parameters(NavigateParams {
                tab_id: None,
                url: url.into(),
            }))
            .await
            .expect(url);
    }
    assert_eq!(fake.navigated.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn evaluate_is_gated_and_bad_ids_rejected() {
    let server = DiveServer::new(Arc::new(Fake::default()), Config::default());
    let err = server
        .page_evaluate(Parameters(EvaluateParams {
            tab_id: None,
            expression: "1".into(),
        }))
        .await
        .unwrap_err();
    assert!(err.message.contains("disabled"));

    let open = DiveServer::new(
        Arc::new(Fake::default()),
        Config {
            allow_evaluate: true,
            ..Default::default()
        },
    );
    let err = open
        .page_text(Parameters(TabRef {
            tab_id: Some("nope".into()),
        }))
        .await
        .unwrap_err();
    assert!(err.message.contains("bad tab id"));
    let err = open
        .page_text(Parameters(TabRef::default()))
        .await
        .unwrap_err();
    assert!(err.message.contains("no open tabs"));
}

#[tokio::test]
async fn server_binds_an_ephemeral_port() {
    let handle = serve(
        Arc::new(Fake::default()),
        Config::default(),
        "127.0.0.1:0".parse().unwrap(),
    )
    .await
    .unwrap();
    assert!(handle.url().starts_with("http://127.0.0.1:"));
    assert_ne!(handle.addr.port(), 0);
    handle.shutdown();
}

async fn status_of(url: &str, headers: &[(&str, &str)]) -> Result<u16, reqwest::Error> {
    let client = reqwest::Client::new();
    let mut req = client
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream");
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    req.body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#)
        .send()
        .await
        .map(|r| r.status().as_u16())
}

#[tokio::test]
async fn token_and_origin_are_enforced() {
    let config = Config {
        allow_evaluate: false,
        token: Some("s3cret".into()),
    };
    let handle = serve(
        Arc::new(Fake::default()),
        config,
        "127.0.0.1:0".parse().unwrap(),
    )
    .await
    .unwrap();
    let url = handle.url();
    match status_of(&url, &[]).await {
        Ok(status) => assert_eq!(status, 401),
        Err(e) => {
            let msg = format!("{e:?}");
            if msg.contains("PermissionDenied") || msg.contains("Operation not permitted") {
                eprintln!("skipping test: sandbox blocked loopback TCP connection");
                handle.shutdown();
                return;
            }
            panic!("request failed: {e:?}");
        }
    }
    assert_eq!(
        status_of(&url, &[("authorization", "Bearer wrong")])
            .await
            .unwrap(),
        401
    );
    assert_eq!(
        status_of(
            &url,
            &[
                ("authorization", "Bearer s3cret"),
                ("origin", "https://evil.example")
            ]
        )
        .await
        .unwrap(),
        403
    );
    assert_eq!(
        status_of(&url, &[("authorization", "Bearer s3cret")])
            .await
            .unwrap(),
        200
    );
    handle.shutdown();
}

#[tokio::test]
async fn page_dialog_defaults_to_accepting_and_passes_prompt_text() {
    let server = DiveServer::new(Arc::new(Fake::default()), Config::default());
    server
        .tab_open(Parameters(OpenParams {
            url: "https://a.dev".into(),
        }))
        .await
        .unwrap();
    let accepted = server
        .page_dialog(Parameters(DialogParams::default()))
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_str(&text_of(&accepted)).unwrap();
    assert_eq!(body["answered"], true);
    let dismissed = server
        .page_dialog(Parameters(DialogParams {
            tab_id: None,
            accept: Some(false),
            text: Some("dale".into()),
        }))
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_str(&text_of(&dismissed)).unwrap();
    assert_eq!(body["answered"], false);
    assert_eq!(body["text"], "dale");
    // The catalog carries it, with the same parameter names the server accepts.
    let entry = tool_catalog()
        .into_iter()
        .find(|t| t.name == "page_dialog")
        .expect("page_dialog in the catalog");
    let props = &entry.input_schema["properties"];
    assert!(
        props.get("accept").is_some()
            && props.get("text").is_some()
            && props.get("tab_id").is_some()
    );
}
