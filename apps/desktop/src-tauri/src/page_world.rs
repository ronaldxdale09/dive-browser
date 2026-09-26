//! Dive's own world in every page.
//!
//! The scripts that fill logins, offer form entries, fill checkouts, record
//! flows, pick elements and listen to a tab's audio used to run in the page's
//! main world. Everything there belongs to the page: it could replace the
//! binding, `JSON.stringify`, `Object.assign` or `Array.prototype.filter`
//! before the script called them, read the nonce as it went past, forge
//! reports with it, and take whatever the host handed back -- a login list, a
//! filled card, the offer of remembered entries.
//!
//! An isolated world shares the page's DOM and nothing of its JavaScript. The
//! scripts are registered into one named world, their bindings exist only in
//! contexts of that name, and every evaluation the host sends them targets
//! that world's context. A page can still dispatch events at the DOM, and
//! they still arrive with `isTrusted` false, which the scripts check where a
//! person's own gesture is what counts. The per-script nonces stay, as a
//! second lock behind the first.
//!
//! Scripts that exist to read or wrap the page's own JavaScript -- the
//! activity guard's constructor hooks, the audio watcher's, the React fiber
//! lookup behind the element picker, the agent's locator engine and the
//! privacy script's fetch hooks -- cannot see any of that from another world,
//! and stay in the page's. They carry no secret there.

use dive_cdp::{CdpError, CdpEvent, CdpSession};
use serde_json::{Value, json};

/// The world every Dive page script shares. One name for all of them: the
/// saved-login list and the form-entries list coordinate through a function
/// one defines and the other calls, which only works inside one world.
pub const WORLD: &str = "dive";

/// `Runtime.addBinding` parameters for a binding that only Dive's world has.
pub fn binding_params(name: &str) -> Value {
    json!({"name": name, "executionContextName": WORLD})
}

/// `Page.addScriptToEvaluateOnNewDocument` parameters that run `source` in
/// Dive's world of every document to come.
pub fn script_params(source: &str) -> Value {
    json!({"source": source, "worldName": WORLD})
}

/// Add a binding that exists in Dive's world only.
pub async fn add_binding(session: &CdpSession, name: &str) -> Result<Value, CdpError> {
    session
        .call("Runtime.addBinding", binding_params(name))
        .await
}

/// Register `source` to run in Dive's world of every document to come.
/// Returns the protocol's answer, whose `identifier` removes it again.
pub async fn add_script(session: &CdpSession, source: &str) -> Result<Value, CdpError> {
    session
        .call(
            "Page.addScriptToEvaluateOnNewDocument",
            script_params(source),
        )
        .await
}

/// Register a binding and the script that calls it, both for Dive's world.
/// The two go out together, the binding first, so it is there when the
/// script first runs.
pub async fn install(session: &CdpSession, binding: &str, source: &str) -> Result<(), CdpError> {
    let (bound, registered) =
        tokio::join!(add_binding(session, binding), add_script(session, source));
    bound?;
    registered?;
    Ok(())
}

/// The context a `Runtime.bindingCalled` came from, when that is Dive's
/// world. The binding is added to that world only, so anything else is
/// either an engine that ignored the restriction or a context the session
/// never heard of; either way it is refused.
pub fn calling_context(session: &CdpSession, event: &CdpEvent) -> Option<i64> {
    let context = event.params["executionContextId"].as_i64()?;
    let world = session.context_world(context);
    if world.as_deref() == Some(WORLD) {
        Some(context)
    } else {
        tracing::debug!(
            context,
            world = world.as_deref().unwrap_or("page"),
            "binding call from outside Dive's world refused"
        );
        None
    }
}

/// Dive's world in the tab's current top document: the context its scripts
/// already run in, or a new one for a document that has none yet (the blank
/// page a view starts on, or one loaded before a script was registered).
pub async fn context(session: &CdpSession) -> Result<i64, CdpError> {
    if let Some(context) = session.world_context(WORLD) {
        return Ok(context);
    }
    create(session).await
}

/// Ask the engine for Dive's world in the top frame. For a document that
/// already has it, the engine answers with the existing context, so the
/// globals its scripts defined are there.
async fn create(session: &CdpSession) -> Result<i64, CdpError> {
    let frame = match session.main_frame() {
        Some(frame) => frame,
        None => session.call0("Page.getFrameTree").await?["frameTree"]["frame"]["id"]
            .as_str()
            .ok_or(CdpError::MissingField("frameTree.frame.id"))?
            .to_owned(),
    };
    let made = session
        .call(
            "Page.createIsolatedWorld",
            json!({"frameId": frame, "worldName": WORLD}),
        )
        .await?;
    let context = made["executionContextId"]
        .as_i64()
        .ok_or(CdpError::MissingField("executionContextId"))?;
    tracing::debug!(frame, context, "Dive world bound for the current document");
    Ok(context)
}

/// `Runtime.evaluate` in one context: `params` is everything but the
/// `contextId`, which is set here.
pub async fn evaluate_in(
    session: &CdpSession,
    context: i64,
    mut params: Value,
) -> Result<Value, CdpError> {
    params["contextId"] = json!(context);
    session.call("Runtime.evaluate", params).await
}

/// `Runtime.evaluate` in Dive's world of the current top document.
///
/// A context the session still believes in can be gone by the time the
/// call lands (the page navigated); the engine then says it cannot find it,
/// and the evaluation is tried once more in the world it makes now.
pub async fn evaluate(session: &CdpSession, params: Value) -> Result<Value, CdpError> {
    let context = context(session).await?;
    match evaluate_in(session, context, params.clone()).await {
        Err(CdpError::Protocol { .. }) => {
            let context = create(session).await?;
            evaluate_in(session, context, params).await
        }
        other => other,
    }
}

/// The origin of the document behind `context`. The engine names it when the
/// context is created, which no page script can touch, and that record
/// outlives the context: a login is reported on submit, and by the time the
/// report is handled the page has usually navigated and the context is gone,
/// so asking it then answered nothing and the save prompt never came. Only a
/// context never reported is asked directly; `location` is the document's
/// own and no world can redefine it.
pub async fn context_origin(session: &CdpSession, context: i64) -> Option<String> {
    if let Some(origin) = session.context_origin(context) {
        return crate::passwords::origin_of(&origin).ok();
    }
    let result = evaluate_in(
        session,
        context,
        json!({"expression": "location.origin", "returnByValue": true}),
    )
    .await
    .ok()?;
    crate::passwords::origin_of(result["result"]["value"].as_str()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Outbox(tokio::sync::mpsc::UnboundedSender<Value>);
    impl dive_cdp::Transport for Outbox {
        fn send(&self, text: &str) -> Result<(), CdpError> {
            self.0
                .send(serde_json::from_str(text).map_err(CdpError::from)?)
                .map_err(|e| CdpError::Transport(e.to_string()))
        }
    }

    fn session() -> (CdpSession, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (CdpSession::new(Outbox(tx)), rx)
    }

    fn feed(session: &CdpSession, message: &Value) {
        session.handle_incoming(&message.to_string()).unwrap();
    }

    fn reply(session: &CdpSession, call: &Value, result: &Value) {
        feed(session, &json!({"id": call["id"], "result": result}));
    }

    fn context_created(id: i64, name: &str, frame: &str, default: bool) -> Value {
        json!({"method": "Runtime.executionContextCreated", "params": {"context": {"id": id, "name": name, "auxData": {"isDefault": default, "frameId": frame}}}})
    }

    fn binding_call(context: i64) -> CdpEvent {
        CdpEvent {
            navigation_epoch: 0,
            method: "Runtime.bindingCalled".into(),
            params: json!({"name": "__diveX", "payload": "{}", "executionContextId": context}),
        }
    }

    #[test]
    fn scripts_and_bindings_are_registered_for_dives_world_only() {
        assert_eq!(
            binding_params("__diveX"),
            json!({"name": "__diveX", "executionContextName": "dive"})
        );
        assert_eq!(
            script_params("1"),
            json!({"source": "1", "worldName": "dive"})
        );
    }

    #[test]
    fn only_a_call_from_dives_world_is_answered() {
        let (session, _calls) = session();
        feed(&session, &context_created(1, "", "top", true));
        feed(&session, &context_created(2, WORLD, "top", false));
        feed(&session, &context_created(3, "other", "top", false));
        assert_eq!(calling_context(&session, &binding_call(2)), Some(2));
        // The page's own world, another isolated world, and a context the
        // session never heard of.
        assert_eq!(calling_context(&session, &binding_call(1)), None);
        assert_eq!(calling_context(&session, &binding_call(3)), None);
        assert_eq!(calling_context(&session, &binding_call(9)), None);
    }

    #[tokio::test]
    async fn evaluation_targets_the_known_world_of_the_top_document() {
        let (session, mut calls) = session();
        feed(
            &session,
            &json!({"method": "Page.frameNavigated", "params": {"frame": {"id": "top", "url": "https://a.test/"}}}),
        );
        feed(&session, &context_created(1, "", "top", true));
        feed(&session, &context_created(4, WORLD, "child", false));
        feed(&session, &context_created(5, WORLD, "top", false));
        let task = tokio::spawn({
            let session = session.clone();
            async move { evaluate(&session, json!({"expression": "1"})).await }
        });
        let call = calls.recv().await.unwrap();
        assert_eq!(call["method"], "Runtime.evaluate");
        assert_eq!(call["params"]["contextId"], 5);
        reply(&session, &call, &json!({"result": {"value": 1}}));
        assert_eq!(task.await.unwrap().unwrap()["result"]["value"], 1);
    }

    #[tokio::test]
    async fn a_document_without_the_world_gets_one_made() {
        let (session, mut calls) = session();
        let task = tokio::spawn({
            let session = session.clone();
            async move { evaluate(&session, json!({"expression": "1"})).await }
        });
        // The top frame is not known yet, so it is asked for first.
        let tree = calls.recv().await.unwrap();
        assert_eq!(tree["method"], "Page.getFrameTree");
        reply(
            &session,
            &tree,
            &json!({"frameTree": {"frame": {"id": "top"}}}),
        );
        let made = calls.recv().await.unwrap();
        assert_eq!(made["method"], "Page.createIsolatedWorld");
        assert_eq!(
            made["params"],
            json!({"frameId": "top", "worldName": "dive"})
        );
        reply(&session, &made, &json!({"executionContextId": 8}));
        let call = calls.recv().await.unwrap();
        assert_eq!(call["params"]["contextId"], 8);
        reply(&session, &call, &json!({"result": {"value": 2}}));
        assert_eq!(task.await.unwrap().unwrap()["result"]["value"], 2);
    }

    #[tokio::test]
    async fn a_context_gone_under_the_call_is_replaced_once() {
        let (session, mut calls) = session();
        feed(
            &session,
            &json!({"method": "Page.frameNavigated", "params": {"frame": {"id": "top", "url": "https://a.test/"}}}),
        );
        feed(&session, &context_created(5, WORLD, "top", false));
        let task = tokio::spawn({
            let session = session.clone();
            async move { evaluate(&session, json!({"expression": "1"})).await }
        });
        let stale = calls.recv().await.unwrap();
        assert_eq!(stale["params"]["contextId"], 5);
        feed(
            &session,
            &json!({"id": stale["id"], "error": {"code": -32000, "message": "Cannot find context with specified id"}}),
        );
        let made = calls.recv().await.unwrap();
        assert_eq!(made["method"], "Page.createIsolatedWorld");
        reply(&session, &made, &json!({"executionContextId": 6}));
        let retried = calls.recv().await.unwrap();
        assert_eq!(retried["params"]["contextId"], 6);
        reply(&session, &retried, &json!({"result": {"value": 3}}));
        assert_eq!(task.await.unwrap().unwrap()["result"]["value"], 3);
    }
}
