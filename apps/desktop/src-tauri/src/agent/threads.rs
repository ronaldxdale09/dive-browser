//! Keeping an agent conversation: how much of it is stored, and when it is forgotten.

use super::{AppError, AppResult, AppState, lock};

/// Longest a saved conversation may be. A longer one keeps its newest
/// messages and loses the oldest, so one runaway tab cannot fill the
/// database and a long conversation still survives a restart.
const THREAD_CAP: usize = 1024 * 1024;
/// How long a conversation is kept after the last thing was said in it.
pub const THREAD_TTL: time::Duration = time::Duration::days(30);

/// The conversation as it will be kept: whole when it fits under
/// [`THREAD_CAP`], otherwise its newest messages.
///
/// Refusing the write outright meant a conversation that grew past the cap
/// silently stopped being saved at all, so a restart brought back whatever it
/// was the last time it fitted. Losing the oldest turns is what the model
/// sees on the next send anyway.
pub(super) fn fit_thread(messages: String) -> AppResult<String> {
    if messages.len() <= THREAD_CAP {
        return Ok(messages);
    }
    let parsed: Vec<serde_json::Value> = serde_json::from_str(&messages)
        .map_err(|_| AppError::new("conversation is not a list of messages"))?;
    let sizes: Vec<usize> = parsed
        .iter()
        .map(|m| serde_json::to_string(m).map_or(usize::MAX, |s| s.len() + 1))
        .collect();
    // Walk back from the newest, keeping what fits with the brackets.
    let mut total = 2usize;
    let mut first = parsed.len();
    while first > 0 {
        let next = total.saturating_add(sizes[first - 1]);
        if next > THREAD_CAP {
            break;
        }
        total = next;
        first -= 1;
    }
    if first == parsed.len() {
        return Err(AppError::new(format!(
            "the newest message alone is over the {THREAD_CAP} byte limit to keep"
        )));
    }
    serde_json::to_string(&parsed[first..]).map_err(AppError::new)
}

/// Drop conversations whose tab has gone and those nobody has touched for
/// [`THREAD_TTL`]. Called from housekeeping.
pub fn prune_threads(state: &AppState) {
    let before = dive_core::Timestamp(time::OffsetDateTime::now_utc() - THREAD_TTL).to_rfc3339();
    match lock(&state.store).agent_threads_prune(&before) {
        Ok(0) => {}
        Ok(n) => tracing::info!("forgot {n} agent conversations"),
        Err(error) => tracing::warn!(%error, "could not prune agent conversations"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_saved_conversation_over_the_cap_keeps_its_newest_messages() {
        let small = r#"[{"id":"m1","role":"user","content":"hi"}]"#.to_owned();
        assert_eq!(fit_thread(small.clone()).unwrap(), small);
        let messages: Vec<serde_json::Value> = (0..40)
            .map(|i| json!({"id": format!("m{i}"), "role": "user", "content": "z".repeat(40 * 1024)}))
            .collect();
        let kept = fit_thread(serde_json::to_string(&messages).unwrap()).unwrap();
        assert!(kept.len() <= THREAD_CAP);
        let kept: Vec<serde_json::Value> = serde_json::from_str(&kept).unwrap();
        assert!(kept.len() < messages.len());
        assert_eq!(kept.last().unwrap()["id"], "m39");
        let huge = serde_json::to_string(&[json!({"content": "q".repeat(THREAD_CAP)})]).unwrap();
        assert!(fit_thread(huge).is_err());
    }
}
