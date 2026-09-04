//! Opt-in, local-fixture native response capture qualification.
use std::time::Duration;

use dive_core::TabId;
use tauri::Manager;

use crate::{AppError, Runtime, state};

pub(crate) async fn verify(
    app: &tauri::AppHandle<Runtime>,
    tab: TabId,
    fixture: &str,
) -> Result<(), AppError> {
    let url = url::Url::parse(fixture).map_err(AppError::new)?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err(AppError::new("capture probe requires its loopback fixture"));
    }
    let session = state::lock(&app.state::<state::AppState>().host)
        .as_ref()
        .and_then(|host| host.cdp(tab))
        .ok_or_else(|| AppError::new("missing capture probe session"))?;
    session
        .call("Page.navigate", serde_json::json!({"url": fixture}))
        .await
        .map_err(AppError::new)?;
    let fixture_result = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let value = match session
                .call(
                    "Runtime.evaluate",
                    serde_json::json!({
                        "expression": "window.captureProbeResult || null", "returnByValue": true
                    }),
                )
                .await
            {
                Ok(value) => value,
                Err(dive_cdp::CdpError::Protocol {
                    code: -32000,
                    message,
                }) if !session.is_closed()
                    && matches!(
                        message.as_str(),
                        "Inspected target navigated or closed" | "Not attached to an active page"
                    ) =>
                {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    continue;
                }
                Err(error) => return Err(AppError::new(error)),
            };
            let result = &value["result"]["value"];
            if result["error"].is_string() {
                return Err(AppError::new(format!("capture fixture: {result}")));
            }
            if result["done"] == true {
                return Ok(result.clone());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(AppError::new)??;
    let rows = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let rows: Vec<_> = app
                .state::<state::AppState>()
                .buffers
                .requests(tab, 1000)
                .into_iter()
                .filter(|row| row.url.contains("capture-case=") || row.url.starts_with("blob:"))
                .collect();
            if rows.len() == 10
                && rows.iter().all(|row| {
                    row.finished_at.is_some()
                        && (row.response_body.is_some() || row.response_body_note.is_some())
                })
            {
                return rows;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| {
        AppError::new(format!(
            "capture rows incomplete: {:?}",
            app.state::<state::AppState>()
                .buffers
                .requests_listing(tab, 30)
        ))
    })?;
    validate_rows(rows, &fixture_result, tab)
}

fn validate_rows(
    rows: Vec<crate::buffers::RequestSummary>,
    fixture_result: &serde_json::Value,
    tab: TabId,
) -> Result<(), AppError> {
    let mut evidence = Vec::new();
    for row in rows {
        let large =
            row.url.contains("large") || fixture_result["largeBlob"].as_str() == Some(&row.url);
        let required = row.url.contains("small-plain") || row.url.contains("small-gzip");
        if row.error.is_some() || row.status != Some(200) {
            return Err(AppError::new(format!("fixture response failed: {row:?}")));
        }
        if large && row.response_body.is_some() {
            return Err(AppError::new(format!(
                "oversized fixture captured: {}",
                row.url
            )));
        }
        if required && row.response_body.is_none() {
            return Err(AppError::new(format!(
                "small fixture was not captured: {row:?}"
            )));
        }
        if let Some(body) = &row.response_body {
            let value: serde_json::Value = serde_json::from_str(body).map_err(AppError::new)?;
            if value["answer"] != 42 || body.len() > crate::network::MAX_BODY {
                return Err(AppError::new(
                    "captured JSON is incomplete or exceeds byte limit",
                ));
            }
        }
        evidence.push(serde_json::json!({"tab_id":tab,"request_id":row.id,"large":large,"url":row.url,"wire_bytes":row.encoded_length,
            "captured_bytes":row.response_body.as_ref().map(String::len),"note":row.response_body_note}));
    }
    println!(
        "DIVE_NETWORK_PROBE: {}",
        serde_json::to_string(&evidence).map_err(AppError::new)?
    );
    println!("DIVE_NETWORK_PROBE: compressed, cached, blob and service-worker capture verified");
    Ok(())
}
