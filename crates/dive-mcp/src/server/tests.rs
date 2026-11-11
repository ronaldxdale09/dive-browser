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
fn tabs_list_says_sleeping_tabs_are_omitted() {
    let entry = tool_catalog()
        .into_iter()
        .find(|e| e.name == "tabs_list")
        .expect("tabs_list");
    assert!(
        entry.description.contains("Sleeping tabs are omitted"),
        "{}",
        entry.description
    );
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
    Addressed, Approved, BrowserError, DEFAULT_WAIT_MS, MAX_LOCATOR_CHARS, TabInfo, Target, serve,
    tool_catalog,
};

#[derive(Default)]
struct Fake {
    tabs: Mutex<Vec<TabInfo>>,
    navigated: Mutex<Vec<(TabId, String)>>,
    /// Tabs `check_tab` refuses, as if they belonged to another profile.
    foreign: Mutex<Vec<TabId>>,
    /// What the person was asked, in order.
    asked: Mutex<Vec<Sensitive>>,
    /// Whether the person says no.
    refuse: std::sync::atomic::AtomicBool,
    /// The rules last set; null until then, which reads as an empty list.
    rules: Mutex<serde_json::Value>,
    /// The origin `confirm` reports back as approved.
    origin: Mutex<Option<String>>,
    /// The `expect_origin` each upload and storage read arrived with.
    expected: Mutex<Vec<Option<String>>>,
    /// How many times `page_storage_set` reached the browser.
    stored: std::sync::atomic::AtomicUsize,
    /// What `page_text` answers instead of "hello", when set.
    body: Mutex<Option<String>>,
}

#[async_trait]
impl Browser for Fake {
    async fn check_tab(&self, tab: TabId) -> Result<(), BrowserError> {
        if self.foreign.lock().unwrap().contains(&tab) {
            return Err(BrowserError::TabNotFound(tab.to_string()));
        }
        Ok(())
    }
    async fn confirm(&self, step: Sensitive) -> Result<Approved, BrowserError> {
        self.asked.lock().unwrap().push(step);
        if self.refuse.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(BrowserError::NotAllowed {
                operation: "that".into(),
                reason: "the person said no".into(),
            });
        }
        Ok(Approved {
            origin: self.origin.lock().unwrap().clone(),
        })
    }
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
        Ok(self
            .body
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "hello".into()))
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
        let rules = self.rules.lock().unwrap().clone();
        Ok(if rules.is_null() {
            serde_json::json!([])
        } else {
            rules
        })
    }
    async fn set_rules(&self, rules: serde_json::Value) -> Result<(), BrowserError> {
        *self.rules.lock().unwrap() = rules;
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
        self.expected
            .lock()
            .unwrap()
            .push(params.expect_origin.clone());
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
        params: crate::params::StorageGetParams,
    ) -> Result<serde_json::Value, BrowserError> {
        self.expected.lock().unwrap().push(params.expect_origin);
        Ok(serde_json::json!({"cookies": [], "local": {}, "session": {}}))
    }

    async fn page_storage_set(
        &self,
        _tab: TabId,
        params: crate::params::StorageSetParams,
    ) -> Result<serde_json::Value, BrowserError> {
        self.expected.lock().unwrap().push(params.expect_origin);
        self.stored
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(serde_json::json!({"set": true}))
    }

    async fn page_storage_clear(
        &self,
        _tab: TabId,
        _params: crate::params::StorageClearParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"cleared": true}))
    }

    async fn page_mouse(
        &self,
        _tab: TabId,
        params: crate::params::MouseParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"steps": params.steps.len()}))
    }

    async fn page_expect(
        &self,
        _tab: TabId,
        params: crate::params::ExpectParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"ok": true, "checked": params.checks.len()}))
    }

    async fn page_pdf(
        &self,
        _tab: TabId,
        _params: crate::params::PdfParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"path": "/tmp/page.pdf"}))
    }

    async fn downloads(
        &self,
        _params: crate::params::DownloadsParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"downloads": []}))
    }

    async fn contexts(&self) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"contexts": []}))
    }

    async fn context_open(
        &self,
        params: crate::params::ContextOpenParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"name": params.name}))
    }

    async fn context_close(
        &self,
        _params: crate::params::ContextCloseParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"closed": true}))
    }

    async fn page_keys(
        &self,
        _tab: TabId,
        params: crate::params::KeysParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(serde_json::json!({"steps": params.steps.len()}))
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
            context_id: None,
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
            .tab_open(Parameters(OpenParams {
                context_id: None,
                url: url.into(),
            }))
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
            context_id: None,
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
            .tab_open(Parameters(OpenParams {
                context_id: None,
                url: url.into(),
            }))
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
    assert!(err.message.contains("DIVE_MCP_ALLOW_EVAL"));

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
    // A sandboxed frame says `null` and a dev server says localhost; both are
    // web pages, and both hold the token only if it leaked to them.
    for origin in ["null", "http://localhost:3000", "http://127.0.0.1:7391"] {
        assert_eq!(
            status_of(
                &url,
                &[("authorization", "Bearer s3cret"), ("origin", origin)]
            )
            .await
            .unwrap(),
            403,
            "{origin}"
        );
    }
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
            context_id: None,
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

#[tokio::test]
async fn a_tab_the_browser_disowns_cannot_be_driven_by_id() {
    let fake = Arc::new(Fake::default());
    let server = DiveServer::new(Arc::clone(&fake), Config::default());
    let foreign = TabId::new();
    fake.foreign.lock().unwrap().push(foreign);
    let err = server
        .page_text(Parameters(TabRef {
            tab_id: Some(foreign.to_string()),
        }))
        .await
        .unwrap_err();
    assert!(err.message.contains("tab not found"), "{}", err.message);
    let err = server
        .tab_navigate(Parameters(NavigateParams {
            tab_id: Some(foreign.to_string()),
            url: "https://a.dev/".into(),
        }))
        .await
        .unwrap_err();
    assert!(err.message.contains("tab not found"), "{}", err.message);
    assert!(fake.navigated.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_client_cannot_claim_or_act_as_dives_agent() {
    let fake = Arc::new(Fake::default());
    let server = DiveServer::new(Arc::clone(&fake), Config::default());
    server
        .tab_open(Parameters(OpenParams {
            context_id: None,
            url: "https://a.dev".into(),
        }))
        .await
        .unwrap();
    let params = || crate::params::ClaimParams {
        tab_id: None,
        holder: crate::lease::DIVE_AGENT.into(),
        seconds: None,
    };
    assert!(server.tab_claim(Parameters(params())).await.is_err());
    assert!(server.tab_release(Parameters(params())).await.is_err());
}

#[tokio::test]
async fn uploads_and_cookie_reads_ask_the_person_first() {
    let fake = Arc::new(Fake::default());
    let server = DiveServer::new(Arc::clone(&fake), Config::default());
    server
        .tab_open(Parameters(OpenParams {
            context_id: None,
            url: "https://a.dev".into(),
        }))
        .await
        .unwrap();
    server
        .page_upload(Parameters(crate::params::UploadParams {
            tab_id: None,
            locator: Some("css=input[type=file]".into()),
            paths: vec!["/Users/me/Documents/cv.pdf".into()],
            expect_origin: None,
        }))
        .await
        .unwrap();
    server
        .page_storage(Parameters(crate::params::StorageGetParams {
            tab_id: None,
            include: None,
            expect_origin: None,
        }))
        .await
        .unwrap();
    // The client is not the page: it cannot run script here, and stored data
    // often holds the token that signs the person in.
    server
        .page_storage(Parameters(crate::params::StorageGetParams {
            tab_id: None,
            include: Some(vec![crate::params::StorageKind::Local]),
            expect_origin: None,
        }))
        .await
        .unwrap();
    let asked = fake.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 3, "{asked:?}");
    assert!(
        matches!(&asked[0], Sensitive::Upload { paths, .. } if paths == &["/Users/me/Documents/cv.pdf"])
    );
    assert!(matches!(asked[1], Sensitive::ReadCookies { .. }));
    assert!(matches!(asked[2], Sensitive::ReadStorage { .. }));

    fake.refuse.store(true, std::sync::atomic::Ordering::SeqCst);
    let err = server
        .page_storage(Parameters(crate::params::StorageGetParams {
            tab_id: None,
            include: Some(vec![crate::params::StorageKind::Cookies]),
            expect_origin: None,
        }))
        .await
        .unwrap_err();
    assert!(err.message.contains("said no"), "{}", err.message);
}

#[test]
fn the_evaluate_description_names_the_switch_that_turns_it_on() {
    let entry = tool_catalog()
        .into_iter()
        .find(|e| e.name == "page_evaluate")
        .unwrap();
    assert!(
        entry.description.contains("DIVE_MCP_ALLOW_EVAL"),
        "{}",
        entry.description
    );
    assert!(!entry.description.contains("enabled it in Dive"));
}

async fn server_with_tab(fake: &Arc<Fake>) -> DiveServer<Fake> {
    let server = DiveServer::new(Arc::clone(fake), Config::default());
    server
        .tab_open(Parameters(OpenParams {
            context_id: None,
            url: "https://a.dev".into(),
        }))
        .await
        .unwrap();
    server
}

async fn set_rules(
    server: &DiveServer<Fake>,
    rules: Vec<serde_json::Value>,
) -> Result<CallToolResult, ErrorData> {
    server
        .rules_set(Parameters(crate::params::RulesParams { rules }))
        .await
}

fn mock_rule(id: &str, body: &str) -> serde_json::Value {
    json!({"id": id, "pattern": "https://api.example/*", "enabled": true,
        "action": {"kind": "mock", "status": 200, "content_type": "text/plain", "body": body}})
}

fn header_rule() -> serde_json::Value {
    json!({"id": "h", "pattern": "https://a.dev/*", "enabled": true,
        "action": {"kind": "header", "name": "x-test", "value": "1"}})
}

#[tokio::test]
async fn reading_no_storage_kinds_asks_nothing() {
    let fake = Arc::new(Fake::default());
    let server = server_with_tab(&fake).await;
    server
        .page_storage(Parameters(crate::params::StorageGetParams {
            tab_id: None,
            include: Some(vec![]),
            expect_origin: None,
        }))
        .await
        .unwrap();
    assert!(fake.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn block_rules_and_removals_do_not_ask() {
    let fake = Arc::new(Fake::default());
    let server = server_with_tab(&fake).await;
    let block = json!({"id": "b", "pattern": "https://ads.example/*", "enabled": true,
        "action": {"kind": "block"}});
    set_rules(&server, vec![block]).await.unwrap();
    set_rules(&server, vec![]).await.unwrap();
    assert!(fake.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn adding_a_mock_or_header_rule_asks_once_per_new_rule_set() {
    let fake = Arc::new(Fake::default());
    let server = server_with_tab(&fake).await;
    set_rules(&server, vec![mock_rule("m", "hi")])
        .await
        .unwrap();
    {
        let asked = fake.asked.lock().unwrap();
        assert_eq!(asked.len(), 1, "{asked:?}");
        assert!(
            matches!(&asked[0], Sensitive::ChangeRules { added } if added[0].starts_with("mock ")),
            "{asked:?}"
        );
    }
    set_rules(&server, vec![mock_rule("m", "hi")])
        .await
        .unwrap();
    assert_eq!(fake.asked.lock().unwrap().len(), 1);
    set_rules(&server, vec![mock_rule("m", "hi"), header_rule()])
        .await
        .unwrap();
    assert_eq!(fake.asked.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_refused_rule_change_leaves_the_rules_as_they_were() {
    let fake = Arc::new(Fake::default());
    let server = server_with_tab(&fake).await;
    fake.refuse.store(true, std::sync::atomic::Ordering::SeqCst);
    set_rules(&server, vec![mock_rule("m", "hi")])
        .await
        .expect_err("the person said no");
    assert_eq!(fake.rules().await.unwrap(), json!([]));
}

#[tokio::test]
async fn switching_a_stored_mock_on_asks_even_though_it_was_set_off() {
    let fake = Arc::new(Fake::default());
    let server = server_with_tab(&fake).await;
    let mut off = mock_rule("m", "hi");
    off["enabled"] = json!(false);
    set_rules(&server, vec![off]).await.unwrap();
    assert!(fake.asked.lock().unwrap().is_empty());
    set_rules(&server, vec![mock_rule("m", "hi")])
        .await
        .unwrap();
    let asked = fake.asked.lock().unwrap();
    assert_eq!(asked.len(), 1, "{asked:?}");
    assert!(
        matches!(&asked[0], Sensitive::ChangeRules { .. }),
        "{asked:?}"
    );
}

#[test]
fn added_rewrites_lists_only_new_enabled_mocks_and_headers() {
    let current = json!([mock_rule("old", "hi")]);
    let mut disabled = mock_rule("d", "other");
    disabled["enabled"] = json!(false);
    assert!(added_rewrites(&current, &[disabled]).is_empty());
    // Only the id differs, so nothing new is being said.
    assert!(added_rewrites(&current, &[mock_rule("renamed", "hi")]).is_empty());
    let changed = added_rewrites(&current, &[mock_rule("old", "different")]);
    assert_eq!(changed, vec!["mock https://api.example/*".to_owned()]);
    // A rule that was off does not make the same rule, switched on, old news.
    let mut off = mock_rule("x", "hi");
    off["enabled"] = json!(false);
    assert_eq!(
        added_rewrites(&json!([off]), &[mock_rule("x", "hi")]),
        vec!["mock https://api.example/*".to_owned()]
    );
    let header = added_rewrites(&json!([]), &[header_rule()]);
    assert_eq!(header, vec!["header https://a.dev/* (x-test)".to_owned()]);
}

#[tokio::test]
async fn the_server_passes_the_approved_origin_on() {
    let fake = Arc::new(Fake::default());
    *fake.origin.lock().unwrap() = Some("https://a.dev".into());
    let server = server_with_tab(&fake).await;
    server
        .page_upload(Parameters(crate::params::UploadParams {
            tab_id: None,
            locator: Some("css=input[type=file]".into()),
            paths: vec!["/Users/me/Documents/cv.pdf".into()],
            expect_origin: Some("https://client.chose".into()),
        }))
        .await
        .unwrap();
    server
        .page_storage(Parameters(crate::params::StorageGetParams {
            tab_id: None,
            include: None,
            expect_origin: None,
        }))
        .await
        .unwrap();
    // Nothing is asked for no kinds, so there is nothing to hold the page to.
    server
        .page_storage(Parameters(crate::params::StorageGetParams {
            tab_id: None,
            include: Some(vec![]),
            expect_origin: Some("https://client.chose".into()),
        }))
        .await
        .unwrap();
    let expected = fake.expected.lock().unwrap().clone();
    assert_eq!(
        expected,
        vec![
            Some("https://a.dev".to_owned()),
            Some("https://a.dev".to_owned()),
            None
        ]
    );
}

#[tokio::test]
async fn cookie_writes_ask_first_and_a_no_stops_them() {
    use std::sync::atomic::Ordering;
    let fake = Arc::new(Fake::default());
    let server = server_with_tab(&fake).await;
    let cookie = |domain: Option<&str>| crate::params::Cookie {
        name: "sid".into(),
        value: "1".into(),
        domain: domain.map(str::to_owned),
        ..Default::default()
    };
    let set = |cookies, local| crate::params::StorageSetParams {
        tab_id: None,
        cookies,
        local,
        session: None,
        expect_origin: None,
    };
    server
        .page_storage_set(Parameters(set(Some(vec![cookie(None)]), None)))
        .await
        .unwrap();
    {
        let asked = fake.asked.lock().unwrap();
        assert_eq!(asked.len(), 1, "{asked:?}");
        assert!(
            matches!(&asked[0], Sensitive::WriteCookies { domains, .. } if domains == &["this page"]),
            "{asked:?}"
        );
    }
    assert_eq!(fake.stored.load(Ordering::SeqCst), 1);

    let mut local = std::collections::BTreeMap::new();
    local.insert("k".to_owned(), "v".to_owned());
    server
        .page_storage_set(Parameters(set(None, Some(local))))
        .await
        .unwrap();
    assert_eq!(fake.asked.lock().unwrap().len(), 1);
    assert_eq!(fake.stored.load(Ordering::SeqCst), 2);

    fake.refuse.store(true, Ordering::SeqCst);
    server
        .page_storage_set(Parameters(set(
            Some(vec![cookie(Some("a.dev")), cookie(Some("a.dev"))]),
            None,
        )))
        .await
        .expect_err("the person said no");
    assert_eq!(fake.stored.load(Ordering::SeqCst), 2);
}

#[test]
fn the_approved_origin_is_not_part_of_any_published_schema() {
    for entry in tool_catalog() {
        assert!(
            !entry.input_schema.to_string().contains("expect_origin"),
            "{}",
            entry.name
        );
    }
}

#[tokio::test]
async fn cookie_writes_are_held_to_the_approved_origin() {
    let fake = Arc::new(Fake::default());
    *fake.origin.lock().unwrap() = Some("https://a.dev".into());
    let server = server_with_tab(&fake).await;
    let write = |origin: Option<&str>, cookies: Vec<crate::params::Cookie>| {
        crate::params::StorageSetParams {
            cookies: Some(cookies),
            expect_origin: origin.map(str::to_owned),
            ..Default::default()
        }
    };
    let cookie = crate::params::Cookie {
        name: "sid".into(),
        value: "1".into(),
        ..Default::default()
    };
    server
        .page_storage_set(Parameters(write(
            Some("https://client.chose"),
            vec![cookie.clone()],
        )))
        .await
        .unwrap();
    // Local storage alone asks nothing, so nothing is checked.
    server
        .page_storage_set(Parameters(crate::params::StorageSetParams {
            local: Some(std::collections::BTreeMap::default()),
            expect_origin: Some("https://client.chose".into()),
            ..Default::default()
        }))
        .await
        .unwrap();
    assert_eq!(
        fake.expected.lock().unwrap().clone(),
        vec![Some("https://a.dev".to_owned()), None]
    );
    // A client cannot name the origin itself.
    let parsed: crate::params::StorageSetParams =
        serde_json::from_value(json!({"expect_origin": "https://evil.dev"})).unwrap();
    assert_eq!(parsed.expect_origin, None);
}

#[test]
fn a_window_counts_characters_and_says_where_to_continue() {
    let text = "é🙂".repeat(10);
    let cut = window(&text, 0, 3);
    assert!(cut.truncated);
    assert_eq!(cut.next_cursor, Some(3));
    assert_eq!(cut.total_chars, 20);
    assert!(cut.text.starts_with("é🙂é\n\n["), "{}", cut.text);
    assert!(
        cut.text
            .contains("[3 of 20 characters. Call again with cursor=3")
    );
    let body: String = cut.text.split("\n\n[").next().unwrap().into();
    assert_eq!(body.chars().count(), 3);
}

#[test]
fn a_cursor_past_the_end_gives_nothing_and_no_next_cursor() {
    let cut = window("hello", 99, 10);
    assert_eq!(cut.text, "");
    assert!(!cut.truncated);
    assert_eq!(cut.next_cursor, None);
}

#[test]
fn the_character_budget_is_clamped_to_one_and_the_ceiling() {
    let zero = window("abcdef", 0, 0);
    assert_eq!(zero.next_cursor, Some(1));
    assert!(zero.text.starts_with("a\n\n["), "{}", zero.text);
    let long = "x".repeat(MAX_MAX_CHARS + 10);
    let huge = window(&long, 0, usize::MAX);
    assert_eq!(huge.next_cursor, Some(MAX_MAX_CHARS));
    assert!(huge.truncated);
}

#[test]
fn bounded_starts_a_text_block_at_the_cursor() {
    let text: String = ('a'..='z').chain('A'..='D').collect();
    assert_eq!(text.chars().count(), 30);
    let response =
        CallToolResponse::Complete(CallToolResult::success(vec![ContentBlock::text(text)]));
    let CallToolResponse::Complete(result) = bounded(response, 10, 5) else {
        panic!("a plain result stays complete");
    };
    let out = text_of(&result);
    assert!(out.starts_with("klmno\n\n["), "{out}");
    assert!(out.contains("Call again with cursor=15"), "{out}");
}

/// The JSON-RPC payload of a streamable-HTTP response, plain or one SSE frame.
fn rpc_payload(body: &str) -> serde_json::Value {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        return v;
    }
    body.lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
        .find_map(|data| serde_json::from_str(data).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// A live MCP session over loopback HTTP, so calls go through `dispatch`.
struct Session {
    client: reqwest::Client,
    url: String,
    sid: Option<String>,
    next: u64,
    handle: crate::http::Handle,
}

impl Session {
    /// `None` when the sandbox blocks loopback TCP.
    async fn start(fake: Arc<Fake>) -> Option<Self> {
        let handle = serve(fake, Config::default(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let url = handle.url();
        let client = reqwest::Client::new();
        let body = json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "dispatch-test", "version": "0"}}
        });
        let sent = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .body(body.to_string())
            .send()
            .await;
        let resp = match sent {
            Ok(resp) => resp,
            Err(e) => {
                let msg = format!("{e:?}");
                if msg.contains("PermissionDenied") || msg.contains("Operation not permitted") {
                    eprintln!("skipping test: sandbox blocked loopback TCP connection");
                    handle.shutdown();
                    return None;
                }
                panic!("initialize failed: {e:?}");
            }
        };
        let sid = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let text = resp.text().await.unwrap();
        assert!(rpc_payload(&text).get("result").is_some(), "{text}");
        Some(Self {
            client,
            url,
            sid,
            next: 1,
            handle,
        })
    }

    /// `tools/call`, answering the JSON-RPC `error` or the call's `result`.
    async fn call(&mut self, name: &str, arguments: serde_json::Value) -> serde_json::Value {
        self.next += 1;
        let body = json!({
            "jsonrpc": "2.0", "id": self.next, "method": "tools/call",
            "params": {"name": name, "arguments": arguments}
        });
        let mut req = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .body(body.to_string());
        if let Some(sid) = &self.sid {
            req = req.header("Mcp-Session-Id", sid);
        }
        let text = req.send().await.unwrap().text().await.unwrap();
        let payload = rpc_payload(&text);
        payload
            .get("error")
            .or_else(|| payload.get("result"))
            .cloned()
            .unwrap_or_else(|| panic!("no result in {text}"))
    }

    fn finish(self) {
        self.handle.shutdown();
    }
}

/// What a call answered, as text: an error's message or a result's text blocks.
fn answer_text(answer: &serde_json::Value) -> String {
    if let Some(message) = answer["message"].as_str() {
        return message.to_owned();
    }
    answer["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn only_tab(fake: &Fake) -> String {
    fake.tabs.lock().unwrap()[0].id.clone()
}

#[tokio::test]
async fn dispatch_refuses_another_holder_on_a_claimed_tab() {
    let fake = Arc::new(seeded_fake());
    let tab = only_tab(&fake);
    let Some(mut session) = Session::start(Arc::clone(&fake)).await else {
        return;
    };
    let claim = session
        .call("tab_claim", json!({"tab_id": tab, "holder": "A"}))
        .await;
    assert_ne!(claim["isError"], true, "{claim}");
    let refused = session
        .call(
            "tab_navigate",
            json!({"tab_id": tab, "url": "https://b.dev", "holder": "B"}),
        )
        .await;
    assert!(answer_text(&refused).contains("\"A\""), "{refused}");
    assert!(fake.navigated.lock().unwrap().is_empty());
    let allowed = session
        .call(
            "tab_navigate",
            json!({"tab_id": tab, "url": "https://b.dev", "holder": "A"}),
        )
        .await;
    assert_ne!(allowed["isError"], true, "{allowed}");
    assert_eq!(fake.navigated.lock().unwrap().len(), 1);
    session.finish();
}

#[tokio::test]
async fn dispatch_gives_every_batch_step_the_batch_holder() {
    let fake = Arc::new(seeded_fake());
    let tab = only_tab(&fake);
    let Some(mut session) = Session::start(Arc::clone(&fake)).await else {
        return;
    };
    session
        .call("tab_claim", json!({"tab_id": tab, "holder": "A"}))
        .await;
    let batch = session
        .call(
            "page_batch",
            json!({"holder": "A", "steps": [
                {"tool": "tab_navigate", "arguments": {"tab_id": tab, "url": "https://1.dev"}},
                {"tool": "tab_navigate", "arguments": {"tab_id": tab, "url": "https://2.dev"}},
            ]}),
        )
        .await;
    assert_ne!(batch["isError"], true, "{batch}");
    assert_eq!(batch["structuredContent"]["ok"], true, "{batch}");
    assert_eq!(batch["structuredContent"]["steps"], 2, "{batch}");
    let urls: Vec<String> = fake
        .navigated
        .lock()
        .unwrap()
        .iter()
        .map(|(_, url)| url.clone())
        .collect();
    assert_eq!(urls, ["https://1.dev", "https://2.dev"]);
    // Without the batch's holder the same steps would have been refused.
    let other = session
        .call(
            "page_batch",
            json!({"holder": "B", "steps": [
                {"tool": "tab_navigate", "arguments": {"tab_id": tab, "url": "https://3.dev"}},
            ]}),
        )
        .await;
    assert_eq!(other["structuredContent"]["ok"], false, "{other}");
    assert_eq!(fake.navigated.lock().unwrap().len(), 2);
    session.finish();
}

#[tokio::test]
async fn dispatch_stops_a_batch_at_the_first_failing_step() {
    let fake = Arc::new(seeded_fake());
    let tab = only_tab(&fake);
    let Some(mut session) = Session::start(Arc::clone(&fake)).await else {
        return;
    };
    let batch = session
        .call(
            "page_batch",
            json!({"steps": [
                {"tool": "tab_navigate", "arguments": {"tab_id": tab, "url": "https://1.dev"}},
                {"tool": "tab_navigate", "arguments": {"id": "x", "url": "https://2.dev"}},
                {"tool": "tab_navigate", "arguments": {"tab_id": tab, "url": "https://3.dev"}},
            ]}),
        )
        .await;
    assert_eq!(batch["isError"], true, "{batch}");
    assert_eq!(batch["structuredContent"]["ok"], false, "{batch}");
    assert_eq!(batch["structuredContent"]["failed_at"], 1, "{batch}");
    let urls: Vec<String> = fake
        .navigated
        .lock()
        .unwrap()
        .iter()
        .map(|(_, url)| url.clone())
        .collect();
    assert_eq!(urls, ["https://1.dev"]);
    session.finish();
}

#[tokio::test]
async fn dispatch_refuses_a_batch_inside_a_batch() {
    let fake = Arc::new(seeded_fake());
    let Some(mut session) = Session::start(Arc::clone(&fake)).await else {
        return;
    };
    let answer = session
        .call(
            "page_batch",
            json!({"steps": [{"tool": "page_batch", "arguments": {"steps": []}}]}),
        )
        .await;
    assert!(
        answer_text(&answer).contains("a batch cannot contain a batch"),
        "{answer}"
    );
    assert!(fake.navigated.lock().unwrap().is_empty());
    session.finish();
}

#[tokio::test]
async fn dispatch_applies_the_callers_text_budget() {
    let fake = Arc::new(seeded_fake());
    *fake.body.lock().unwrap() = Some("0123456789".repeat(10));
    let tab = only_tab(&fake);
    let Some(mut session) = Session::start(Arc::clone(&fake)).await else {
        return;
    };
    let cut = session
        .call("page_text", json!({"tab_id": tab, "max_chars": 10}))
        .await;
    let text = answer_text(&cut);
    assert!(text.starts_with("0123456789\n\n["), "{text}");
    assert!(text.contains("Call again with cursor=10"), "{text}");
    session.finish();
}
