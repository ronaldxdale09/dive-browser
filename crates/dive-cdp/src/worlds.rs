//! Which execution contexts belong to a named isolated world.
//!
//! A script registered with `Page.addScriptToEvaluateOnNewDocument` and a
//! `worldName` runs in a world of its own: it shares the page's DOM but none
//! of its JavaScript, so page script can neither read what it holds nor
//! replace the functions it calls. A binding added with an
//! `executionContextName` exists only in contexts of that name. What the
//! protocol does not say, on a `Runtime.bindingCalled` or anywhere else after
//! the fact, is which world a context id belongs to; only
//! `Runtime.executionContextCreated` names it. So the session keeps that
//! record as the events arrive, and a caller can ask whether a binding call
//! came from its own world and which context to evaluate in for the current
//! document.

use std::collections::HashMap;

use serde_json::Value;

/// More named contexts than any tab has alive at once. A page can make a
/// frame per element, each with a context in every world; past this many the
/// oldest records go, which only means a very old frame's call is refused.
const MAX_CONTEXTS: usize = 4096;

#[derive(Debug, Clone)]
struct NamedContext {
    world: String,
    frame_id: String,
    /// Creation order, so the newest context of a world in a frame wins
    /// when an old document's context has not been reported gone yet.
    order: u64,
}

/// The named (isolated) execution contexts a session has been told about.
#[derive(Debug, Default)]
pub(crate) struct Worlds {
    contexts: HashMap<i64, NamedContext>,
    next: u64,
}

impl Worlds {
    /// Follow one protocol event. Only the three `Runtime` events about
    /// execution contexts change anything.
    pub(crate) fn observe(&mut self, method: &str, params: &Value) {
        match method {
            "Runtime.executionContextCreated" => {
                let context = &params["context"];
                let auxiliary = &context["auxData"];
                // The page's own world is the default one and has no name
                // worth trusting; only isolated worlds are recorded.
                if auxiliary["isDefault"].as_bool() == Some(true) {
                    return;
                }
                let (Some(id), Some(world)) = (context["id"].as_i64(), context["name"].as_str())
                else {
                    return;
                };
                if world.is_empty() {
                    return;
                }
                let frame_id = auxiliary["frameId"].as_str().unwrap_or_default();
                if self.contexts.len() >= MAX_CONTEXTS
                    && let Some(oldest) = self
                        .contexts
                        .iter()
                        .min_by_key(|(_, context)| context.order)
                        .map(|(id, _)| *id)
                {
                    self.contexts.remove(&oldest);
                }
                self.next += 1;
                tracing::debug!(
                    context = id,
                    frame = frame_id,
                    world,
                    "isolated world context created"
                );
                self.contexts.insert(
                    id,
                    NamedContext {
                        world: world.to_owned(),
                        frame_id: frame_id.to_owned(),
                        order: self.next,
                    },
                );
            }
            "Runtime.executionContextDestroyed" => {
                if let Some(id) = params["executionContextId"].as_i64() {
                    self.contexts.remove(&id);
                }
            }
            "Runtime.executionContextsCleared" => self.contexts.clear(),
            _ => {}
        }
    }

    /// The world a live context belongs to, when it is a named one.
    pub(crate) fn world_of(&self, context_id: i64) -> Option<&str> {
        self.contexts
            .get(&context_id)
            .map(|context| context.world.as_str())
    }

    /// The newest live context of `world` in `frame_id`.
    pub(crate) fn context_in(&self, world: &str, frame_id: &str) -> Option<i64> {
        self.contexts
            .iter()
            .filter(|(_, context)| context.world == world && context.frame_id == frame_id)
            .max_by_key(|(_, context)| context.order)
            .map(|(id, _)| *id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn created(id: i64, name: &str, frame: &str, default: bool) -> Value {
        json!({"context": {"id": id, "name": name, "auxData": {"isDefault": default, "frameId": frame, "type": if default { "default" } else { "isolated" }}}})
    }

    #[test]
    fn records_isolated_worlds_by_context_and_frame() {
        let mut worlds = Worlds::default();
        worlds.observe(
            "Runtime.executionContextCreated",
            &created(1, "", "top", true),
        );
        worlds.observe(
            "Runtime.executionContextCreated",
            &created(2, "dive", "top", false),
        );
        worlds.observe(
            "Runtime.executionContextCreated",
            &created(3, "dive", "child", false),
        );
        // The page's own world is never taken for one of ours, whatever it
        // is called.
        assert_eq!(worlds.world_of(1), None);
        assert_eq!(worlds.world_of(2), Some("dive"));
        assert_eq!(worlds.context_in("dive", "top"), Some(2));
        assert_eq!(worlds.context_in("dive", "child"), Some(3));
        assert_eq!(worlds.context_in("other", "top"), None);
    }

    #[test]
    fn a_default_context_cannot_claim_a_world_name() {
        let mut worlds = Worlds::default();
        worlds.observe(
            "Runtime.executionContextCreated",
            &created(1, "dive", "top", true),
        );
        assert_eq!(worlds.world_of(1), None);
        assert_eq!(worlds.context_in("dive", "top"), None);
    }

    #[test]
    fn the_newest_context_of_a_frame_wins_and_gone_ones_are_forgotten() {
        let mut worlds = Worlds::default();
        worlds.observe(
            "Runtime.executionContextCreated",
            &created(7, "dive", "top", false),
        );
        // The next document's world is reported before the old one is gone.
        worlds.observe(
            "Runtime.executionContextCreated",
            &created(5, "dive", "top", false),
        );
        assert_eq!(worlds.context_in("dive", "top"), Some(5));
        worlds.observe(
            "Runtime.executionContextDestroyed",
            &json!({"executionContextId": 5}),
        );
        assert_eq!(worlds.context_in("dive", "top"), Some(7));
        assert_eq!(worlds.world_of(5), None);
        worlds.observe("Runtime.executionContextsCleared", &json!({}));
        assert_eq!(worlds.world_of(7), None);
        assert_eq!(worlds.context_in("dive", "top"), None);
    }

    #[test]
    fn the_record_stays_bounded() {
        let mut worlds = Worlds::default();
        let total = i64::try_from(MAX_CONTEXTS).unwrap() + 10;
        for id in 0..total {
            worlds.observe(
                "Runtime.executionContextCreated",
                &created(id, "dive", "frame", false),
            );
        }
        assert_eq!(worlds.contexts.len(), MAX_CONTEXTS);
        assert_eq!(worlds.world_of(0), None, "the oldest went first");
        assert_eq!(worlds.world_of(total - 1), Some("dive"));
    }
}
