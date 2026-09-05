//! Read-only heap diagnostics for the disposable memory benchmark.
use crate::AppError;
use dive_cdp::CdpSession;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use tauri::Manager;

fn fields(response: &Value, names: &[&str]) -> Result<Value, AppError> {
    let mut out = serde_json::Map::new();
    for name in names {
        response[*name]
            .as_f64()
            .filter(|number| number.is_finite() && *number >= 0.0)
            .ok_or_else(|| AppError::new(format!("missing or invalid memory metric {name}")))?;
        out.insert((*name).to_string(), response[*name].clone());
    }
    Ok(Value::Object(out))
}

async fn collect(sessions: Vec<CdpSession>) -> Result<BTreeMap<String, Value>, AppError> {
    let mut samples = BTreeMap::new();
    for session in sessions {
        let reply = session
            .call("Runtime.getIsolateId", json!({}))
            .await
            .map_err(AppError::new)?;
        let id = reply["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or_else(|| AppError::new("memory probe missing isolate identity"))?;
        if samples.contains_key(id) {
            continue;
        }
        let heap = session
            .call("Runtime.getHeapUsage", json!({}))
            .await
            .map_err(AppError::new)?;
        let dom = session
            .call("Memory.getDOMCounters", json!({}))
            .await
            .map_err(AppError::new)?;
        samples.insert(id.to_string(), json!({
            "heap":fields(&heap, &["usedSize", "totalSize", "embedderHeapUsedSize", "backingStorageSize"] )?,
            "dom":fields(&dom, &["documents", "nodes", "jsEventListeners"] )?
        }));
    }
    if samples.is_empty() {
        return Err(AppError::new("memory probe has no live isolate"));
    }
    Ok(samples)
}

pub(crate) async fn record(
    app: &tauri::AppHandle<crate::Runtime>,
    phase: &str,
) -> Result<(), AppError> {
    if std::env::var_os("DIVE_STRESS_HEAP_METRICS").is_none() {
        return Ok(());
    }
    if std::env::var("DIVE_USE_MOCK_KEYCHAIN").as_deref() != Ok("1")
        || std::env::var_os("DIVE_DATA_DIR").is_none()
    {
        return Err(AppError::new(
            "heap diagnostic requires explicit isolated test profile and mock keychain",
        ));
    }
    let state = app.state::<crate::state::AppState>();
    let sessions = crate::state::lock(&state.host)
        .as_ref()
        .map(crate::engine::TabHost::sessions)
        .unwrap_or_default()
        .into_iter()
        .map(|(_, session)| session)
        .collect();
    let samples = tokio::time::timeout(std::time::Duration::from_secs(10), collect(sessions))
        .await
        .map_err(AppError::new)??;
    println!(
        "DIVE_MEMORY_HEAP: {}",
        json!({"phase":phase,"isolates":samples})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_invalid_or_unrelated_fields_are_not_reported_as_zero() {
        assert!(fields(&json!({"usedSize": -1}), &["usedSize"]).is_err());
        assert!(fields(&json!({}), &["usedSize"]).is_err());
        assert!(fields(&json!({"usedSize":"private value"}), &["usedSize"]).is_err());
        assert_eq!(
            fields(
                &json!({"usedSize":0,"unknown":"do not retain"}),
                &["usedSize"]
            )
            .unwrap(),
            json!({"usedSize":0})
        );
    }
    struct Messages(tokio::sync::mpsc::UnboundedSender<Value>);
    impl dive_cdp::Transport for Messages {
        fn send(&self, message: &str) -> Result<(), dive_cdp::CdpError> {
            self.0.send(serde_json::from_str(message).unwrap()).unwrap();
            Ok(())
        }
    }
    #[tokio::test]
    async fn shared_isolates_are_sampled_once_without_forcing_collection() {
        let (tx, mut calls) = tokio::sync::mpsc::unbounded_channel();
        let session = CdpSession::new(Messages(tx));
        let peers = vec![session.clone(), session.clone()];
        let task = tokio::spawn(collect(peers));
        for (method, result) in [
            ("Runtime.getIsolateId", json!({"id":"shared"})),
            (
                "Runtime.getHeapUsage",
                json!({"usedSize":10,"totalSize":20,"embedderHeapUsedSize":30,"backingStorageSize":40}),
            ),
            (
                "Memory.getDOMCounters",
                json!({"documents":2,"nodes":5000,"jsEventListeners":3}),
            ),
            ("Runtime.getIsolateId", json!({"id":"shared"})),
        ] {
            let call = tokio::time::timeout(std::time::Duration::from_millis(100), calls.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(call["method"], method);
            session
                .handle_incoming(&json!({"id":call["id"],"result":result}).to_string())
                .unwrap();
        }
        let samples = task.await.unwrap().unwrap();
        assert_eq!(samples.len(), 1);
        assert_eq!(samples["shared"]["heap"]["backingStorageSize"], 40);
        assert_eq!(samples["shared"]["dom"]["nodes"], 5000);
        assert!(calls.try_recv().is_err());
    }

    #[tokio::test]
    async fn missing_or_closed_sessions_never_claim_a_heap_sample() {
        assert!(collect(vec![]).await.is_err());
        let (tx, mut calls) = tokio::sync::mpsc::unbounded_channel();
        let session = CdpSession::new(Messages(tx));
        session.close();
        assert!(collect(vec![session]).await.is_err());
        assert!(calls.try_recv().is_err());
    }
}
