//! Disposable native qualification of the production Fetch owner and filters.
use std::{collections::HashMap, path::Path, time::Duration};

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::{TabId, WorkspaceId};
use serde_json::{Value, json};
use tauri::Manager;

use crate::{AppError, Runtime, prefs::Prefs, rules, state};

const OWNER: &str = "dive-fetch-filter-probe-v1";
const TRACKER: &str = "ads.doubleclick.net";
const MARKER: &str = "DIVE_FETCH_FILTER_PROBE: privacy block, media bypass, wildcard rule, privacy restore and off verified";
const PHASES: [&str; 4] = ["privacy", "workspace", "restored", "off"];

pub(crate) struct Config {
    fixture: url::Url,
}

fn admit(
    flag: &str,
    mock: &str,
    mode: &str,
    profile: Option<&Path>,
    fixture: &str,
    competing: bool,
) -> Result<Option<Config>, AppError> {
    if flag.is_empty() {
        return Ok(None);
    }
    let owned = profile
        .filter(|path| !path.as_os_str().is_empty())
        .is_some_and(|path| {
            std::fs::read_to_string(path.join("fetch-filter-probe.owner"))
                .is_ok_and(|text| text == OWNER)
        });
    let fixture =
        url::Url::parse(fixture).map_err(|_| AppError::new("invalid Fetch probe fixture"))?;
    if flag != "1"
        || mock != "1"
        || mode != "quit"
        || !owned
        || competing
        || fixture.scheme() != "http"
        || fixture.host_str() != Some("127.0.0.1")
        || fixture.port().is_none_or(|port| port == 0)
        || fixture.path() != "/"
        || fixture.query().is_some()
        || fixture.fragment().is_some()
        || !fixture.username().is_empty()
        || fixture.password().is_some()
    {
        return Err(AppError::new(
            "Fetch probe requires explicit flag, mock keychain, owned disposable profile, lifecycle quit and loopback fixture",
        ));
    }
    Ok(Some(Config { fixture }))
}

pub(crate) fn config() -> Result<Option<Config>, AppError> {
    admit(
        &std::env::var("DIVE_FETCH_FILTER_PROBE").unwrap_or_default(),
        &std::env::var("DIVE_USE_MOCK_KEYCHAIN").unwrap_or_default(),
        &std::env::var("DIVE_NATIVE_LIFECYCLE_PROBE").unwrap_or_default(),
        std::env::var_os("DIVE_DATA_DIR").as_deref().map(Path::new),
        &std::env::var("DIVE_FETCH_FILTER_PROBE_URL").unwrap_or_default(),
        [
            "DIVE_UI_PROBE",
            "DIVE_CRASH_PROBE",
            "DIVE_NETWORK_CAPTURE_PROBE_URL",
            "DIVE_PERMISSION_CACHE_PROBE",
            "DIVE_STRESS_TABS",
            "DIVE_SMOKE",
            "DIVE_CDP_BENCH",
            "DIVE_STARTUP_BENCHMARK",
            "DIVE_OPEN_URL",
        ]
        .iter()
        .any(|key| std::env::var_os(key).is_some()),
    )
}

/// Fixed per-launch routing: the known tracker goes to the local fixture,
/// unrelated DNS names cannot resolve, and ambient proxies cannot bypass this.
pub(crate) fn chromium_args() -> Result<Vec<(&'static str, Option<String>)>, AppError> {
    Ok(if config()?.is_some() {
        vec![
            (
                "host-resolver-rules",
                Some(format!(
                    "EXCLUDE 127.0.0.1, MAP {TRACKER} 127.0.0.1, MAP * ~NOTFOUND"
                )),
            ),
            ("--no-proxy-server", None),
        ]
    } else {
        Vec::new()
    })
}

#[derive(Default)]
struct Case {
    requested: u32,
    paused: u32,
    finished: u32,
    blocked: u32,
    failed: u32,
    wrong_type: bool,
    terminal_failures: Vec<Value>,
}

fn inspector_block(params: &Value) -> bool {
    // Pinned Blink adds the blocked-request detail to LocalizedDescription;
    // the browser-side Network handler emits the unsuffixed net error instead.
    matches!(
        params["errorText"].as_str(),
        Some("net::ERR_BLOCKED_BY_CLIENT" | "net::ERR_BLOCKED_BY_CLIENT.Inspector")
    ) && params["blockedReason"] == "inspector"
        && params.get("canceled").is_none_or(|value| value == false)
}

fn terminal_evidence(params: &Value) -> Value {
    let error = match params["errorText"].as_str() {
        Some("net::ERR_BLOCKED_BY_CLIENT") => "net::ERR_BLOCKED_BY_CLIENT",
        Some("net::ERR_BLOCKED_BY_CLIENT.Inspector") => "net::ERR_BLOCKED_BY_CLIENT.Inspector",
        Some("net::ERR_ABORTED") => "net::ERR_ABORTED",
        Some("net::ERR_NAME_NOT_RESOLVED") => "net::ERR_NAME_NOT_RESOLVED",
        Some("net::ERR_FAILED") => "net::ERR_FAILED",
        _ => "unknown",
    };
    let reason = match params["blockedReason"].as_str() {
        Some("inspector") => "inspector",
        Some("csp") => "csp",
        Some("other") => "other",
        None => "absent",
        _ => "unknown",
    };
    json!({"error":error,"blockedReason":reason,"canceled":params["canceled"].as_bool()})
}

#[derive(Default)]
struct Facts {
    cases: [Case; 3],
    requests: HashMap<String, usize>,
    observed: usize,
}

fn fixture_case(url: &str, phase: &str, port: u16) -> Option<usize> {
    let url = url::Url::parse(url).ok()?;
    if url.scheme() != "http" || url.port() != Some(port) || url.query() != Some(phase) {
        return None;
    }
    match (url.host_str()?, url.path()) {
        ("127.0.0.1", "/control.js") => Some(0),
        (TRACKER, "/tracker.js") => Some(1),
        (TRACKER, "/fixture.wav") => Some(2),
        _ => None,
    }
}

impl Facts {
    fn observe(&mut self, event: &CdpEvent, phase: &str, port: u16) -> Result<(), AppError> {
        self.observed += 1;
        if self.observed > 512 {
            return Err(AppError::new("Fetch probe event bound exceeded"));
        }
        let p = &event.params;
        match event.method.as_str() {
            "Network.requestWillBeSent" | "Fetch.requestPaused" => {
                let Some(index) = p["request"]["url"]
                    .as_str()
                    .and_then(|url| fixture_case(url, phase, port))
                else {
                    return Ok(());
                };
                let paused = event.method == "Fetch.requestPaused";
                let kind = p[if paused { "resourceType" } else { "type" }].as_str();
                self.cases[index].wrong_type |=
                    kind != Some(if index == 2 { "Media" } else { "Script" });
                if paused {
                    self.cases[index].paused += 1;
                } else {
                    self.cases[index].requested += 1;
                    let id = p["requestId"]
                        .as_str()
                        .filter(|id| id.len() <= 128)
                        .ok_or_else(|| AppError::new("missing bounded network identity"))?;
                    if self.requests.len() >= 64 {
                        return Err(AppError::new("Fetch probe request bound exceeded"));
                    }
                    self.requests.insert(id.to_owned(), index);
                }
            }
            "Network.loadingFinished" | "Network.loadingFailed" => {
                if let Some(index) = p["requestId"]
                    .as_str()
                    .and_then(|id| self.requests.remove(id))
                {
                    let case = &mut self.cases[index];
                    if event.method == "Network.loadingFinished" {
                        case.finished += 1;
                    } else {
                        if case.terminal_failures.len() < 8 {
                            case.terminal_failures.push(terminal_evidence(p));
                        }
                        if inspector_block(p) {
                            case.blocked += 1;
                        } else {
                            case.failed += 1;
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn complete(&self) -> bool {
        self.cases
            .iter()
            .all(|case| case.finished + case.blocked + case.failed > 0)
    }

    fn evidence(&self, phase: &str) -> Value {
        json!({"phase":phase,"cases":self.cases.iter().map(|case| json!({
            "requested":case.requested,"paused":case.paused,"finished":case.finished,
            "blocked":case.blocked,"failed":case.failed,"wrongType":case.wrong_type,
            "terminalFailures":case.terminal_failures
        })).collect::<Vec<_>>()})
    }

    fn validate(&self, phase: &str, document: &Value) -> Result<(), AppError> {
        for (index, case) in self.cases.iter().enumerate() {
            let blocked = (index == 1 && phase != "off") || (index == 0 && phase == "workspace");
            let paused = phase != "off" && index != 2;
            let loaded = document[["control", "tracker", "media"][index]].as_bool();
            if case.requested == 0
                || case.wrong_type
                || case.failed != 0
                || (case.paused > 0) != paused
                || loaded != Some(!blocked)
                || (case.blocked > 0) != blocked
                || (case.finished > 0) == blocked
            {
                return Err(AppError::new(format!(
                    "Fetch phase contract failed: {}",
                    self.evidence(phase)
                )));
            }
        }
        Ok(())
    }
}

async fn set_policy(
    app: &tauri::AppHandle<Runtime>,
    workspace: WorkspaceId,
    session: &CdpSession,
    prefs: Prefs,
    rules: Vec<rules::Rule>,
) -> Result<(), AppError> {
    let state = app.state::<state::AppState>();
    let _update = state.prefs.begin_update().await;
    state.rules.set(&state, workspace, rules.clone())?;
    let prefs = state.prefs.set(&state, prefs)?;
    rules::apply(session, &rules, &prefs).await
}

async fn verify_phases(
    app: &tauri::AppHandle<Runtime>,
    workspace: WorkspaceId,
    session: &CdpSession,
    prefs: &Prefs,
    config: &Config,
) -> Result<(), AppError> {
    let mut events = session.subscribe(); // Passive observer; rules::attach remains sole Fetch responder.
    let mut enabled = prefs.clone();
    enabled.block_trackers = true;
    enabled.privacy_exceptions.clear();
    // Establish document ownership before a known tracker request is issued.
    set_policy(app, workspace, session, enabled.clone(), vec![]).await?;
    session
        .call("Page.navigate", json!({"url":config.fixture.as_str()}))
        .await
        .map_err(AppError::new)?;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if super::read_probe_value(session, "typeof window.runFetchFilterProbe === 'function'")
                .await?
                == true
            {
                return Ok::<_, AppError>(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(AppError::new)??;
    for phase in PHASES {
        let mut phase_prefs = enabled.clone();
        phase_prefs.block_trackers = phase != "off";
        let phase_rules = if phase == "workspace" {
            vec![rules::Rule {
                id: "fetch-probe-script".into(),
                pattern: format!("{}control.js*", config.fixture),
                enabled: true,
                action: rules::RuleAction::Block,
            }]
        } else {
            vec![]
        };
        set_policy(app, workspace, session, phase_prefs, phase_rules).await?;
        // Earlier phases have terminal receipts before their observer state is cleared.
        loop {
            match events.try_recv() {
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
                Err(error) => return Err(AppError::new(error)),
            }
        }
        let reply = session
            .call(
                "Runtime.evaluate",
                json!({
                    "expression":format!("window.runFetchFilterProbe({})", json!(phase)),
                    "awaitPromise":true,"returnByValue":true
                }),
            )
            .await
            .map_err(AppError::new)?;
        if reply.get("exceptionDetails").is_some() {
            return Err(AppError::new("Fetch fixture script failed"));
        }
        let mut facts = Facts::default();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !facts.complete() {
                let event = events.recv().await.map_err(AppError::new)?;
                facts.observe(&event, phase, config.fixture.port().unwrap())?;
            }
            Ok::<_, AppError>(())
        })
        .await
        .map_err(AppError::new)??;
        facts.validate(phase, &reply["result"]["value"])?;
        println!("DIVE_FETCH_FILTER_PHASE: {}", facts.evidence(phase));
    }
    Ok::<_, AppError>(())
}

/// Exercise the document path through the production Fetch owner, including
/// changing a live rule back to privacy-only filtering.
async fn verify_documents(
    app: &tauri::AppHandle<Runtime>,
    workspace: WorkspaceId,
    session: &CdpSession,
    prefs: &Prefs,
    config: &Config,
) -> Result<(), AppError> {
    let mut prefs = prefs.clone();
    prefs.block_trackers = true;
    prefs.privacy_exceptions.clear();
    for phase in ["privacy", "mock", "disabled"] {
        let mut events = session.subscribe();
        let rules = if phase == "privacy" {
            vec![]
        } else {
            vec![rules::Rule {
                id: "fetch-document-probe".into(),
                pattern: format!("{}?document=*", config.fixture),
                enabled: phase == "mock",
                action: rules::RuleAction::Mock {
                    status: 200,
                    content_type: "text/html".into(),
                    body: "<!doctype html><title>Document mock verified</title>".into(),
                },
            }]
        };
        set_policy(app, workspace, session, prefs.clone(), rules).await?;
        let url = format!("{}?document={phase}", config.fixture);
        session
            .call("Page.navigate", json!({"url":url}))
            .await
            .map_err(AppError::new)?;
        let expected = if phase == "mock" {
            "Document mock verified"
        } else {
            "Fetch filter fixture"
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let expression = format!("location.href === {} && document.readyState === 'complete' && document.title === {}", json!(url), json!(expected));
                if super::read_probe_value(session, &expression).await? == true {
                    return Ok::<_, AppError>(());
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }).await.map_err(AppError::new)??;
        let mut requested = 0;
        let mut paused = 0;
        loop {
            match events.try_recv() {
                Ok(event) if event.params["request"]["url"] == url => match event.method.as_str() {
                    "Network.requestWillBeSent" => requested += 1,
                    "Fetch.requestPaused" => paused += 1,
                    _ => {}
                },
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
                Err(error) => return Err(AppError::new(error)),
            }
        }
        if requested == 0 || paused != u32::from(phase == "mock") {
            return Err(AppError::new(format!(
                "document filtering failed: {phase}, requested={requested}, paused={paused}"
            )));
        }
        println!(
            "DIVE_FETCH_DOCUMENT: {}",
            json!({"phase":phase,"requested":requested,"paused":paused})
        );
    }
    Ok(())
}

pub(crate) async fn verify(app: &tauri::AppHandle<Runtime>, tab: TabId) -> Result<(), AppError> {
    let Some(config) = config()? else {
        return Ok(());
    };
    let (workspace, prefs, original_rules, session) = {
        let state = app.state::<state::AppState>();
        let workspace = state::lock(&state.store)
            .tab(tab)?
            .workspace_id
            .ok_or_else(|| AppError::new("probe tab has no workspace"))?;
        let prefs = state.prefs.get(&state);
        let rules = state.rules.list(&state, workspace);
        let session = state::lock(&state.host)
            .as_ref()
            .and_then(|host| host.cdp(tab))
            .ok_or_else(|| AppError::new("probe session missing"))?;
        (workspace, prefs, rules, session)
    };
    let run = async {
        verify_phases(app, workspace, &session, &prefs, &config).await?;
        verify_documents(app, workspace, &session, &prefs, &config).await
    };
    let result = tokio::time::timeout(Duration::from_secs(35), run)
        .await
        .map_err(AppError::new)
        .and_then(std::convert::identity);
    // Restore authoritative state even after a failed phase, before lifecycle Quit.
    let restored = tokio::time::timeout(
        Duration::from_secs(5),
        set_policy(app, workspace, &session, prefs, original_rules),
    )
    .await
    .map_err(AppError::new)
    .and_then(std::convert::identity);
    restored?;
    result?;
    println!("{MARKER}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_requires_every_guard_and_exact_owned_loopback_fixture() {
        let directory = tempfile::tempdir().unwrap();
        let profile = Some(directory.path());
        let fixture = "http://127.0.0.1:34567/";
        assert!(admit("", "", "", None, "", false).unwrap().is_none());
        assert!(admit("1", "1", "quit", profile, fixture, false).is_err());
        std::fs::write(directory.path().join("fetch-filter-probe.owner"), OWNER).unwrap();
        assert!(
            admit("1", "1", "quit", profile, fixture, false)
                .unwrap()
                .is_some()
        );
        for (flag, mock, mode, profile, competing) in [
            ("yes", "1", "quit", profile, false),
            ("1", "yes", "quit", profile, false),
            ("1", "1", "window-close", profile, false),
            ("1", "1", "quit", None, false),
            ("1", "1", "quit", profile, true),
        ] {
            assert!(admit(flag, mock, mode, profile, fixture, competing).is_err());
        }
        for fixture in [
            "http://example.test:34567/",
            "https://127.0.0.1:34567/",
            "http://127.0.0.1/",
            "http://127.0.0.1:0/",
            "http://localhost:34567/",
            "http://user@127.0.0.1:34567/",
            "http://127.0.0.1:34567/elsewhere",
            "http://127.0.0.1:34567/?query",
            "http://127.0.0.1:34567/#fragment",
        ] {
            assert!(
                admit("1", "1", "quit", profile, fixture, false).is_err(),
                "{fixture}"
            );
        }
    }

    fn event(method: &str, params: Value) -> CdpEvent {
        CdpEvent {
            method: method.into(),
            params,
        }
    }

    fn phase_facts(phase: &str) -> (Facts, Value) {
        let mut facts = Facts::default();
        let mut document = json!({});
        for (index, (kind, name, origin)) in [
            ("Script", "control.js", "127.0.0.1"),
            ("Script", "tracker.js", TRACKER),
            ("Media", "fixture.wav", TRACKER),
        ]
        .into_iter()
        .enumerate()
        {
            let url = format!("http://{origin}:34567/{name}?{phase}");
            let id = index.to_string();
            facts
                .observe(
                    &event(
                        "Network.requestWillBeSent",
                        json!({"requestId":id,"type":kind,"request":{"url":url}}),
                    ),
                    phase,
                    34567,
                )
                .unwrap();
            if phase != "off" && index != 2 {
                facts
                    .observe(
                        &event(
                            "Fetch.requestPaused",
                            json!({"resourceType":kind,"request":{"url":url}}),
                        ),
                        phase,
                        34567,
                    )
                    .unwrap();
            }
            let blocked = (index == 1 && phase != "off") || (index == 0 && phase == "workspace");
            document[["control", "tracker", "media"][index]] = json!(!blocked);
            facts
                .observe(
                    &event(
                        if blocked {
                            "Network.loadingFailed"
                        } else {
                            "Network.loadingFinished"
                        },
                        json!({"requestId":id,"errorText":"net::ERR_BLOCKED_BY_CLIENT","blockedReason":"inspector","canceled":false}),
                    ),
                    phase,
                    34567,
                )
                .unwrap();
        }
        (facts, document)
    }

    #[test]
    fn phases_require_positive_delivery_and_expected_pause_and_block_evidence() {
        for phase in PHASES {
            let (facts, document) = phase_facts(phase);
            assert!(facts.complete());
            facts.validate(phase, &document).unwrap();
            assert!(!Facts::default().complete());
            assert!(Facts::default().validate(phase, &document).is_err());
        }
        let (mut facts, document) = phase_facts("privacy");
        facts.cases[1].paused = 0;
        assert!(facts.validate("privacy", &document).is_err());
        let (mut facts, document) = phase_facts("privacy");
        facts.cases[2].paused = 1;
        assert!(facts.validate("privacy", &document).is_err());
        let (mut facts, document) = phase_facts("workspace");
        facts.cases[2].blocked = 0;
        facts.cases[2].failed = 1;
        assert!(facts.validate("workspace", &document).is_err());
        let (mut facts, document) = phase_facts("off");
        facts.cases[0].paused = 1;
        assert!(facts.validate("off", &document).is_err());
    }

    #[test]
    fn inspector_blocking_accepts_pinned_renderer_description_and_rejects_other_failures() {
        for (error, reason, canceled, blocked) in [
            (
                "net::ERR_BLOCKED_BY_CLIENT.Inspector",
                "inspector",
                false,
                true,
            ),
            ("net::ERR_BLOCKED_BY_CLIENT", "inspector", false, true),
            ("net::ERR_BLOCKED_BY_CLIENT", "csp", false, false),
            (
                "net::ERR_BLOCKED_BY_CLIENT.Inspector",
                "other",
                false,
                false,
            ),
            (
                "net::ERR_BLOCKED_BY_CLIENT.Inspector",
                "inspector",
                true,
                false,
            ),
            ("net::ERR_NAME_NOT_RESOLVED", "inspector", false, false),
            ("net::ERR_FAILED", "inspector", false, false),
            ("net::ERR_BLOCKED_BY_CLIENT.CSP", "csp", false, false),
        ] {
            let mut facts = Facts::default();
            facts.requests.insert("tracker".into(), 1);
            facts.observe(&event("Network.loadingFailed", json!({
                "requestId":"tracker", "errorText":error,"blockedReason":reason,"canceled":canceled
            })), "privacy", 34567).unwrap();
            assert_eq!(
                facts.cases[1].blocked,
                u32::from(blocked),
                "{error} {reason} canceled={canceled}"
            );
            assert_eq!(facts.cases[1].failed, u32::from(!blocked));
        }
    }

    #[test]
    fn terminal_metadata_is_allowlisted_bounded_and_cannot_relax_block_qualification() {
        let mut facts = Facts::default();
        for _ in 0..10 {
            facts.requests.insert("tracker".into(), 1);
            facts
                .observe(
                    &event(
                        "Network.loadingFailed",
                        json!({
                            "requestId":"tracker", "errorText":"private URL or arbitrary message",
                            "blockedReason":"private reason", "canceled":"private value"
                        }),
                    ),
                    "privacy",
                    34567,
                )
                .unwrap();
        }
        assert_eq!(facts.cases[1].blocked, 0);
        assert_eq!(facts.cases[1].failed, 10);
        assert_eq!(facts.cases[1].terminal_failures.len(), 8);
        assert!(facts.cases[1].terminal_failures.iter().all(|record| *record
            == json!({
                "error":"unknown", "blockedReason":"unknown", "canceled":null
            })));
        assert!(!facts.evidence("privacy").to_string().contains("private"));

        let blocked = json!({"errorText":"net::ERR_BLOCKED_BY_CLIENT.Inspector", "blockedReason":"inspector"});
        assert!(inspector_block(&blocked)); // canceled is optional in CDP.
        for canceled in [json!(true), json!(null), json!("false")] {
            let mut malformed = blocked.clone();
            malformed["canceled"] = canceled;
            assert!(!inspector_block(&malformed));
        }
        assert!(!inspector_block(
            &json!({"errorText":"net::ERR_BLOCKED_BY_CLIENT"})
        ));
    }

    #[test]
    fn bundled_privacy_matches_the_local_fixture_host_without_blocking_media() {
        let privacy = crate::privacy::DivePrivacy::new();
        let prefs = Prefs {
            block_trackers: true,
            ..Prefs::default()
        };
        let script = rules::PausedRequest {
            url: "http://ads.doubleclick.net:34567/tracker.js?privacy",
            document_url: "http://127.0.0.1:34567/",
            resource_type: "Script",
            method: "GET",
        };
        assert!(matches!(
            rules::decide_paused_request(&[], &privacy, &prefs, &script),
            rules::InterceptAction::PrivacyBlock { .. }
        ));
        let media = rules::PausedRequest {
            url: "http://ads.doubleclick.net:34567/fixture.wav?privacy",
            resource_type: "Media",
            ..script
        };
        assert_eq!(
            rules::decide_paused_request(&[], &privacy, &prefs, &media),
            rules::InterceptAction::Continue
        );
    }

    #[test]
    fn fixture_correlation_requires_exact_host_port_path_and_phase() {
        assert_eq!(
            fixture_case(
                "http://ads.doubleclick.net:34567/fixture.wav?privacy",
                "privacy",
                34567
            ),
            Some(2)
        );
        for url in [
            "http://ads.doubleclick.net:34568/fixture.wav?privacy",
            "http://ads.doubleclick.net:34567/fixture.wav?off",
            "https://ads.doubleclick.net:34567/fixture.wav?privacy",
            "http://outside.test:34567/fixture.wav?privacy",
            "http://ads.doubleclick.net:34567/elsewhere?privacy",
        ] {
            assert_eq!(fixture_case(url, "privacy", 34567), None);
        }
    }
}
