//! Fixed-shape diagnostic projection; never retain CDP messages or player data.

use serde_json::{Value, json};

const LIMIT: usize = 64;

#[derive(Debug, PartialEq)]
pub(super) struct MediaError {
    pub(super) error_type: &'static str,
    pub(super) code: i32,
}

pub(super) struct MediaErrors {
    admitted: bool,
    count: usize,
}

impl MediaErrors {
    pub(super) fn new(admitted: bool) -> Self {
        Self { admitted, count: 0 }
    }

    pub(super) fn full(&self) -> bool {
        self.count >= LIMIT
    }

    pub(super) fn collect(&mut self, method: &str, params: &Value) -> Vec<MediaError> {
        if !self.admitted || self.full() || method != "Media.playerErrorsRaised" {
            return Vec::new();
        }
        let Some(errors) = params["errors"].as_array() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        // Inspect at most one capped batch. Never recurse into cause/data/stack.
        for error in errors.iter().take(LIMIT) {
            if self.full() {
                break;
            }
            // These group names come from the pinned Chromium media/base
            // pipeline_status.h, decoder_status.h and encoder_status.h.
            let error_type = match error["errorType"].as_str() {
                Some("PipelineStatus") => "PipelineStatus",
                Some("DecoderStatus") => "DecoderStatus",
                Some("EncoderStatus") => "EncoderStatus",
                _ => continue,
            };
            let Some(code) = error["code"]
                .as_i64()
                .and_then(|code| i32::try_from(code).ok())
            else {
                continue;
            };
            self.count += 1;
            out.push(MediaError { error_type, code });
        }
        out
    }
}

pub(super) fn screen_media(value: &Value) -> Value {
    let Some(rows) = value.as_array() else {
        return Value::Null;
    };
    let numeric = |row: &Value, field: &str, max: Option<u64>, integer: bool| {
        let value = &row[field];
        let allowed = value.as_f64().is_some_and(|v| v.is_finite() && v >= 0.0)
            && (!integer || value.as_u64().is_some())
            && max.is_none_or(|max| value.as_u64().is_some_and(|v| v <= max));
        if allowed { value.clone() } else { Value::Null }
    };
    Value::Array(rows.iter().skip(rows.len().saturating_sub(LIMIT)).filter_map(|row| {
        let event = match row["event"].as_str()? {
            "lease_setup" => "lease_setup", "lease_release" => "lease_release",
            "media_error" => "media_error", "export_begin" => "export_begin",
            "export_seek_failed" => "export_seek_failed", "export_seek_timeout" => "export_seek_timeout",
            "export_seek_cancelled" => "export_seek_cancelled", "export_end" => "export_end",
            _ => return None,
        };
        let phase = match row["phase"].as_str()? {
            "idle" => "idle", "preparing" => "preparing", "seeking" => "seeking",
            "rendering" => "rendering", "draining" => "draining", "flushing" => "flushing",
            "uploading" => "uploading", "finishing" => "finishing", "done" => "done",
            _ => return None,
        };
        Some(json!({
            "atMs":numeric(row,"atMs",None,false), "event":event, "phase":phase,
            "generation":numeric(row,"generation",None,true), "exporting":numeric(row,"exporting",Some(1),true),
            "frame":numeric(row,"frame",None,true), "targetMs":numeric(row,"targetMs",None,false),
            "code":numeric(row,"code",None,true), "currentTime":numeric(row,"currentTime",None,false),
            "seeking":numeric(row,"seeking",Some(1),true), "paused":numeric(row,"paused",Some(1),true),
            "readyState":numeric(row,"readyState",Some(4),true), "networkState":numeric(row,"networkState",Some(3),true)
        }))
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_capture_requires_admission_and_ignores_other_domains() {
        let params = json!({"errors":[{"errorType":"PipelineStatus","code":3}]});
        assert!(
            MediaErrors::new(false)
                .collect("Media.playerErrorsRaised", &params)
                .is_empty()
        );
        assert!(
            MediaErrors::new(true)
                .collect("Media.playerMessagesLogged", &params)
                .is_empty()
        );
        assert_eq!(
            MediaErrors::new(true).collect("Media.playerErrorsRaised", &params),
            vec![MediaError {
                error_type: "PipelineStatus",
                code: 3
            }]
        );
    }

    #[test]
    fn only_known_error_groups_and_integer_codes_are_copied() {
        let params = json!({"playerId":"secret-url", "errors":[
            {"errorType":"PipelineStatus","code":3,"message":"secret","data":{"url":"secret"},"stack":["secret"],"cause":[{"errorType":"DecoderStatus","code":103}]},
            {"errorType":"DecoderStatus","code":103},
            {"errorType":"EncoderStatus","code":1},
            {"errorType":"secret","code":2},
            {"errorType":"PipelineStatus","code":"3"},
            {"errorType":"PipelineStatus","code":3.5},
            {"errorType":"PipelineStatus","code":2_147_483_648_u64}
        ]});
        assert_eq!(
            MediaErrors::new(true).collect("Media.playerErrorsRaised", &params),
            vec![
                MediaError {
                    error_type: "PipelineStatus",
                    code: 3
                },
                MediaError {
                    error_type: "DecoderStatus",
                    code: 103
                },
                MediaError {
                    error_type: "EncoderStatus",
                    code: 1
                },
            ]
        );
    }

    #[test]
    fn media_errors_have_a_lifetime_cap_across_batches() {
        let batch = json!({"errors":vec![json!({"errorType":"PipelineStatus","code":3}); 50]});
        let mut capture = MediaErrors::new(true);
        assert_eq!(
            capture.collect("Media.playerErrorsRaised", &batch).len(),
            50
        );
        assert_eq!(
            capture.collect("Media.playerErrorsRaised", &batch).len(),
            14
        );
        assert!(capture.full());
        assert!(
            capture
                .collect("Media.playerErrorsRaised", &batch)
                .is_empty()
        );
    }

    #[test]
    fn frontend_projection_drops_unknown_fields_and_invalid_types_and_caps_ring() {
        let record = json!({"atMs":4,"event":"media_error","phase":"seeking","generation":2,
            "exporting":1,"frame":3,"targetMs":5,"code":3,"currentTime":0.25,"seeking":0,"paused":1,
            "readyState":2,"networkState":1,"src":"secret","message":"secret","stack":"secret"});
        let mut ring = vec![record.clone(); 70];
        ring.push(json!({"event":"secret","phase":"idle"}));
        let projected = screen_media(&json!(ring));
        let rows = projected.as_array().expect("array");
        assert_eq!(rows.len(), 63);
        assert_eq!(rows[0].as_object().unwrap().len(), 13);
        assert_eq!(rows[0]["currentTime"], json!(0.25));
        assert!(!projected.to_string().contains("secret"));
        let mut invalid = record;
        invalid["exporting"] = json!(2);
        invalid["frame"] = json!("secret");
        invalid["readyState"] = json!(10);
        let invalid = screen_media(&json!([invalid]));
        assert!(invalid[0]["exporting"].is_null());
        assert!(invalid[0]["frame"].is_null());
        assert!(invalid[0]["readyState"].is_null());
        assert!(screen_media(&Value::Null).is_null());
    }
}
