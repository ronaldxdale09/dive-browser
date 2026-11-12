//! The agent run loop: streaming a round, running the tool calls it asks for, and turning an approval into a result.

use super::prompt::{context_block, page_context, stable_prompt};
use super::*;

/// Why a round ended before the loop could carry on. The chrome has already
/// been told either way.
enum Ended {
    /// The person pressed Stop.
    Stopped,
    /// The provider failed and the failure was reported.
    Failed,
}

/// Answer the tool calls a round announced and never ran, so their rows in
/// the chrome stop spinning and say what became of them.
fn abandon(run: &Run, on_delta: &Channel<ChatDelta>, calls: &[dive_agent::ToolUse], why: &str) {
    for call in calls {
        let _ = on_delta.send(ChatDelta::ToolDone {
            id: run.step_id(&call.id),
            summary: why.to_owned(),
            error: true,
        });
    }
}

pub(super) async fn drive(
    browser: &crate::mcp::AppBrowser,
    state: &AppState,
    run: &Run,
    fitted: Fitted,
    tab_id: Option<TabId>,
    options: SendOptions,
    on_delta: &Channel<ChatDelta>,
) -> AppResult<()> {
    let stopped = |on_delta: &Channel<ChatDelta>| {
        let _ = on_delta.send(ChatDelta::Done("stopped".into()));
    };
    let prefs = state.prefs.get(state);
    tracing::Span::current().record("provider", prefs.agent_provider.as_str());
    let provider = parse_provider(&prefs.agent_provider)?;
    let client = client_for(state, provider, None);
    if fitted.trimmed {
        let _ = on_delta.send(ChatDelta::Status(
            "The oldest messages were left out so the conversation fits in one request.".into(),
        ));
    }
    // Reading the page runs a script in it and resolves source maps, which a
    // busy page can make slow; Stop is answered during the read, not after.
    let context = match tab_id {
        Some(id) if options.include_page => tokio::select! {
            () = run.halted() => {
                stopped(on_delta);
                return Ok(());
            }
            context = page_context(state, id) => context,
        },
        _ => String::new(),
    };
    // The attached page is page content like any read, and goes in the same
    // fence: a title or a console line is the page's to choose.
    let context = if context.is_empty() {
        context
    } else {
        let source = tab_id
            .and_then(|id| lock(&state.store).tab(id).ok())
            .map_or_else(|| "the page".to_owned(), |tab| tab.url);
        let attempt = crate::agent_guard::scan(&context);
        if let Some(attempt) = &attempt {
            let _ = on_delta.send(ChatDelta::Flagged(format!(
                "{} {}: “{}”",
                host_of(&source),
                attempt.what,
                attempt.quote
            )));
        }
        crate::agent_guard::envelope(&run.tag, &source, &context, attempt.as_ref())
    };
    let mut request = Request::new(
        stable_prompt(options.clean_session),
        fitted
            .turns
            .into_iter()
            .map(|t| {
                Turn::text(
                    if t.role == "assistant" {
                        Role::Assistant
                    } else {
                        Role::User
                    },
                    t.content,
                )
            })
            .collect(),
    );
    request.context = context_block(&context);
    request.tools = crate::agent_tools::specs();
    request.model = prefs.agent_model.clone();
    request.effort = Effort::parse(&prefs.agent_reasoning);
    let max_steps = usize::try_from(prefs.agent_max_steps).unwrap_or(25).max(1);
    // "Allow all this session" is the person answering ahead of time, so it
    // overrides the setting for this run only -- except for the steps that
    // always ask, which no answer given in advance covers.
    let approvals = if options.auto_approve {
        Approvals::Never
    } else {
        Approvals::parse(&prefs.agent_approvals)
    };
    let tools = AppTools {
        state,
        browser,
        tab_id,
        approvals,
    };
    rounds(&client, &mut request, run, on_delta, max_steps, &tools).await
}

/// Something that opens one round's reply stream. The real one is the
/// provider client; tests script it.
pub(crate) trait OpenStream: Sync {
    fn open<'a>(
        &'a self,
        request: &'a dive_agent::Request,
    ) -> futures_util::future::BoxFuture<
        'a,
        Result<futures_util::stream::BoxStream<'static, Delta>, dive_agent::AgentError>,
    >;
}

impl OpenStream for dive_agent::Client {
    fn open<'a>(
        &'a self,
        request: &'a dive_agent::Request,
    ) -> futures_util::future::BoxFuture<
        'a,
        Result<futures_util::stream::BoxStream<'static, Delta>, dive_agent::AgentError>,
    > {
        Box::pin(async move { self.stream(request).await.map(StreamExt::boxed) })
    }
}

/// The two places the round loop reaches into the app.
pub(crate) trait RoundTools: Sync {
    /// The row drawn when a call streams in.
    fn announce(&self, run: &Run, call: &dive_agent::ToolUse) -> ToolStep;
    /// Run one round's calls.
    fn run_calls<'a>(
        &'a self,
        run: &'a Run,
        on_delta: &'a Channel<ChatDelta>,
        calls: &'a [dive_agent::ToolUse],
    ) -> futures_util::future::BoxFuture<'a, Vec<dive_agent::ToolResult>>;
}

/// The app's own tools: the real step rows and the real browser.
struct AppTools<'a> {
    state: &'a AppState,
    browser: &'a crate::mcp::AppBrowser,
    tab_id: Option<TabId>,
    approvals: Approvals,
}

impl RoundTools for AppTools<'_> {
    fn announce(&self, run: &Run, call: &dive_agent::ToolUse) -> ToolStep {
        step_for(self.state, run, self.tab_id, call, None)
    }

    fn run_calls<'a>(
        &'a self,
        run: &'a Run,
        on_delta: &'a Channel<ChatDelta>,
        calls: &'a [dive_agent::ToolUse],
    ) -> futures_util::future::BoxFuture<'a, Vec<dive_agent::ToolResult>> {
        Box::pin(run_calls(
            self.state,
            run,
            self.browser,
            on_delta,
            self.tab_id,
            calls,
            self.approvals,
        ))
    }
}

/// Largest conversation a round will send. Anthropic refuses requests over
/// 32 MB; staying well under leaves room for tools, system and encoding.
const REQUEST_SOFT_CAP: usize = 24 * 1024 * 1024;

/// Bytes one turn adds to a request.
fn turn_bytes(turn: &Turn) -> usize {
    serde_json::to_vec(&turn.content).map_or(0, |v| v.len())
}

/// Run rounds until the reply ends, fails, is stopped or hits the step limit.
#[allow(clippy::too_many_lines)] // Keep the streamed tool-loop state machine in execution order.
async fn rounds(
    opener: &impl OpenStream,
    request: &mut dive_agent::Request,
    run: &Run,
    on_delta: &Channel<ChatDelta>,
    max_steps: usize,
    tools: &impl RoundTools,
) -> AppResult<()> {
    let stopped = |on_delta: &Channel<ChatDelta>| {
        let _ = on_delta.send(ChatDelta::Done("stopped".into()));
    };
    let mut total = Usage::default();
    let mut steps_used = 0usize;
    let mut sent_bytes = request.system.len()
        + request.context.len()
        + request.turns.iter().map(turn_bytes).sum::<usize>();
    loop {
        if run.is_cancelled() {
            stopped(on_delta);
            return Ok(());
        }
        // Earlier turns are never edited to make room (that would miss the
        // cache); a run that outgrows the provider's limit stops instead.
        if sent_bytes > REQUEST_SOFT_CAP {
            fail(
                on_delta,
                "This run has gathered more than the provider accepts in one request (mostly screenshots). Start a new message to continue; earlier results won't be re-sent.",
                FailureKind::Other,
            );
            return Ok(());
        }
        let Ok(stream) = start_stream(opener, request, run, on_delta).await else {
            return Ok(());
        };
        tokio::pin!(stream);
        let mut text = String::new();
        let mut calls = Vec::new();
        let mut assistant: Option<Turn> = None;
        let mut stop = None;
        loop {
            let delta = tokio::select! {
                () = run.halted() => {
                    abandon(run, on_delta, &calls, "Not run: the run was stopped.");
                    stopped(on_delta);
                    return Ok(());
                }
                next = tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()) => match next {
                    Ok(Some(delta)) => delta,
                    Ok(None) => break,
                    Err(_) => {
                        abandon(run, on_delta, &calls, "Not run: the reply stopped arriving.");
                        fail(
                            on_delta,
                            "The provider stopped sending data for two minutes.",
                            FailureKind::Other,
                        );
                        return Ok(());
                    }
                },
            };
            match delta {
                Delta::Text(t) => {
                    text.push_str(&t);
                    if on_delta.send(ChatDelta::Text(t)).is_err() {
                        return Ok(());
                    }
                }
                Delta::Reasoning(t) => {
                    let _ = on_delta.send(ChatDelta::Reasoning(t));
                }
                Delta::ToolUse(call) => {
                    let _ = on_delta.send(ChatDelta::ToolCall(tools.announce(run, &call)));
                    calls.push(call);
                }
                Delta::Usage(u) => {
                    tracing::debug!(
                        input = u.input_tokens,
                        cache_read = u.cache_read_tokens,
                        "agent round usage"
                    );
                    total.add(u);
                    let _ = on_delta.send(ChatDelta::Usage(total));
                }
                Delta::Assistant(turn) => assistant = Some(turn),
                Delta::Done(reason) => stop = Some(reason),
                Delta::Error(e) => {
                    abandon(run, on_delta, &calls, "Not run: the reply failed.");
                    fail(on_delta, e, FailureKind::Other);
                    return Ok(());
                }
            }
        }
        let Some(stop) = stop else {
            abandon(run, on_delta, &calls, "Not run: the reply was cut short.");
            fail(
                on_delta,
                "The provider stream ended before it completed the reply.",
                FailureKind::Other,
            );
            return Ok(());
        };
        if calls.is_empty() || stop != "tool_use" {
            abandon(run, on_delta, &calls, "Not run: the reply ended first.");
            let _ = on_delta.send(ChatDelta::Done(stop));
            return Ok(());
        }
        if steps_used + calls.len() > max_steps {
            abandon(
                run,
                on_delta,
                &calls,
                "Not run: the step limit was reached.",
            );
            fail(
                on_delta,
                format!(
                    "Stopped after {max_steps} tool calls. Raise the limit in Settings → Agent, or break the task up."
                ),
                FailureKind::Other,
            );
            return Ok(());
        }
        steps_used += calls.len();
        // The wire hands back the turn exactly as it must be replayed --
        // thinking blocks and provider state included. Rebuilding it from
        // the text and calls is the fallback for a stream that ended early.
        let assistant_turn = assistant.unwrap_or_else(|| {
            let mut blocks = Vec::new();
            if !text.is_empty() {
                blocks.push(json!({"type": "text", "text": text}));
            }
            blocks.extend(calls.iter().map(
                |c| json!({"type": "tool_use", "id": c.id, "name": c.name, "input": c.input}),
            ));
            Turn::assistant_blocks(blocks)
        });
        let results = tools.run_calls(run, on_delta, &calls).await;
        if run.is_cancelled() {
            stopped(on_delta);
            return Ok(());
        }
        let results_turn = Turn::tool_results(results);
        sent_bytes += turn_bytes(&assistant_turn) + turn_bytes(&results_turn);
        request.turns.push(assistant_turn);
        request.turns.push(results_turn);
    }
}

/// How many times a round is asked for before the run gives up.
const STREAM_ATTEMPTS: u32 = 3;

/// Open the stream for one round, waiting out a provider that is rate-limiting
/// or briefly broken.
///
/// Retried here and nowhere else: at this point the round has emitted nothing,
/// so asking again cannot duplicate text the person has already read. A
/// failure mid-stream is left alone for that reason. Only transient statuses
/// are retried — a bad key or a malformed request fails identically however
/// many times it is sent, and retrying would just spend the person's tokens.
///
/// Whatever ends the round early has been reported to the chrome by the time
/// this returns, so a Stop during the wait is a stopped reply rather than an
/// error, and a failure says what kind of failure it was.
async fn start_stream(
    opener: &impl OpenStream,
    request: &dive_agent::Request,
    run: &Run,
    on_delta: &Channel<ChatDelta>,
) -> Result<futures_util::stream::BoxStream<'static, Delta>, Ended> {
    let mut attempt = 1;
    loop {
        let attempted = tokio::select! {
            () = run.halted() => {
                let _ = on_delta.send(ChatDelta::Done("stopped".into()));
                return Err(Ended::Stopped);
            }
            attempted = opener.open(request) => attempted,
        };
        match attempted {
            Ok(stream) => return Ok(stream),
            Err(e) if e.is_transient() && attempt < STREAM_ATTEMPTS => {
                let wait = dive_agent::retry_delay(attempt, e.retry_after());
                // Say so rather than appearing to hang: a rate limit can ask
                // for twenty seconds, and silence reads as a stall. It is a
                // status, not reply text, so it never reaches the model.
                let _ = on_delta.send(ChatDelta::Status(format!(
                    "The provider is busy; trying again in {}s.",
                    wait.as_secs().max(1)
                )));
                tracing::info!(attempt, ?wait, "provider asked us to wait; retrying");
                // Stop is answered during the wait, not after it: a person
                // who presses Stop should not sit through the backoff.
                tokio::select! {
                    () = run.halted() => {
                        let _ = on_delta.send(ChatDelta::Done("stopped".into()));
                        return Err(Ended::Stopped);
                    }
                    () = tokio::time::sleep(wait) => {}
                }
                attempt += 1;
            }
            Err(e) => {
                fail(on_delta, e.to_string(), FailureKind::of(&e));
                return Err(Ended::Failed);
            }
        }
    }
}

/// What a call's result says when the host did not run it.
const STOPPED_BEFORE_RUN: &str = "The user stopped the run before this ran.";

/// What a call's result is when it was not run, by why. A stopped run wins
/// over any answer to an approval.
fn refusal(approval: Approval, cancelled: bool) -> Option<&'static str> {
    if cancelled {
        return Some(STOPPED_BEFORE_RUN);
    }
    match approval {
        Approval::Allowed => None,
        Approval::Denied => Some(
            "The user did not allow this action. Do not retry it; explain what you wanted to do instead.",
        ),
        Approval::Unanswered => Some(
            "Nobody answered the approval request within 2 minutes, so this action was skipped. Do not retry it; say what you wanted to do so the user can allow it next time.",
        ),
    }
}

/// Whether a finished call leaves the run holding `name`'s site data.
fn leaves_taint(ran: bool, result: &dive_agent::ToolResult, name: &str) -> bool {
    ran && !result.is_error && crate::agent_risk::taints(name)
}

/// Whether a finished call leaves the softer mark of having read a page.
fn leaves_sight(ran: bool, result: &dive_agent::ToolResult, name: &str) -> bool {
    ran && !result.is_error && crate::agent_risk::reads_page(name)
}

/// Execute one round of tool calls in order (gating actions on approval),
/// reporting each outcome to the chrome. A stopped run answers the calls it
/// did not make with a denial, so the transcript stays well-formed.
async fn run_calls(
    state: &AppState,
    run: &Run,
    browser: &crate::mcp::AppBrowser,
    on_delta: &Channel<ChatDelta>,
    tab_id: Option<TabId>,
    calls: &[dive_agent::ToolUse],
    approvals: Approvals,
) -> Vec<dive_agent::ToolResult> {
    let mut results = Vec::with_capacity(calls.len());
    for call in calls {
        // One span per step: the MCP call and CDP lines it causes nest under
        // it, so a step can be followed through the log. Names only, never
        // the arguments.
        let span =
            tracing::debug_span!("agent.step", step = %run.step_id(&call.id), tool = %call.name);
        let result = async {
            // A click at a coordinate or a key pressed into whatever has focus
            // names nothing the risk check can read. Ask the engine what it is
            // aimed at first, so "Delete account" is judged as that and not as
            // (412, 230).
            let target = match crate::agent_tools::call_tab(tab_id, &call.input) {
                Some(tab) if !run.is_cancelled() => tokio::select! {
                    () = run.halted() => None,
                    target = resolve_target(browser, tab, call) => target,
                },
                _ => None,
            };
            let step = step_for(state, run, tab_id, call, target.as_deref());
            let denied = |why: &str| dive_agent::ToolResult {
                tool_use_id: call.id.clone(),
                content: serde_json::Value::String(why.into()),
                is_error: true,
            };
            let approval = if run.is_cancelled() {
                Approval::Denied
            } else if approvals.asks_about(&step) {
                // The row was drawn when the call streamed in, before the target
                // was known; the question carries what it is actually about.
                approved(state, run, on_delta, &step).await
            } else {
                Approval::Allowed
            };
            // Whether the browser produced this result, rather than the host
            // refusing to run the call. Only the first can carry page content.
            let mut ran = false;
            let result = if let Some(why) = refusal(approval, run.is_cancelled()) {
                denied(why)
            } else {
                // A tool can wait a long while -- for a page to load, for a
                // selector to appear -- and Stop has to end that wait rather than
                // queue behind it. Dropping the call abandons its reply; nothing
                // it holds outlives the await.
                tokio::select! {
                    () = run.halted() => denied(STOPPED_BEFORE_RUN),
                    result = crate::agent_tools::run(browser, tab_id, &run.scope, call) => {
                        ran = true;
                        result
                    }
                }
            };
            // A read of cookies, a response or the console leaves the run holding
            // that site's private data, whether or not it found any.
            if leaves_taint(ran, &result, &call.name)
                && let Some(site) = crate::agent_tools::call_tab(tab_id, &call.input)
                    .and_then(|tab| lock(&state.store).tab(tab).ok())
                    .and_then(|tab| crate::site::of(&tab.url))
            {
                run.taint(site);
            }
            // Reading a page of the person's own leaves a softer mark. Pages the
            // run opened itself, and everything in a clean session, are ones it
            // chose or that hold nothing of the person's.
            if leaves_sight(ran, &result, &call.name)
                && run.scope.context().is_none()
                && let Some(tab) = crate::agent_tools::call_tab(tab_id, &call.input)
                && !run.scope.opened().contains(&tab)
                && let Some(site) = lock(&state.store)
                    .tab(tab)
                    .ok()
                    .and_then(|row| crate::site::of(&row.url))
            {
                run.saw(site);
            }
            // The row's summary is the tool's own first line, taken before the
            // fence goes round it.
            let summary = match &result.content {
                serde_json::Value::String(s) => s
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .chars()
                    .take(160)
                    .collect(),
                _ => "image".to_owned(),
            };
            // Everything the browser hands back passed through a page on its
            // way, errors and action results included. Fence it, and if the page
            // was addressing the agent rather than the reader, say so to both
            // the model and the person.
            let result = if ran {
                guard(state, run, on_delta, tab_id, call, result)
            } else {
                result
            };
            let _ = on_delta.send(ChatDelta::ToolDone {
                id: run.step_id(&call.id),
                summary,
                error: result.is_error,
            });
            result
        }
        .instrument(span)
        .await;
        results.push(result);
    }
    results
}

/// What a step is aimed at, when its arguments do not say by name: the
/// element under a coordinate, or the element that has focus when keys are
/// pressed or text typed with no target.
async fn resolve_target(
    browser: &crate::mcp::AppBrowser,
    tab: TabId,
    call: &dive_agent::ToolUse,
) -> Option<String> {
    let input = &call.input;
    let named = input["locator"].as_str().is_some() || input["ref"].as_str().is_some();
    match call.name.as_str() {
        "page_click" | "page_type" | "page_press" | "page_select" if !named => {
            match (input["x"].as_f64(), input["y"].as_f64()) {
                (Some(x), Some(y)) => browser.describe_point(tab, x, y).await,
                // A key pressed with no target goes to what has focus.
                _ if call.name == "page_press" => browser.describe_focused(tab).await,
                _ => None,
            }
        }
        "page_keys" if input["locator"].as_str().is_none() => browser.describe_focused(tab).await,
        "page_mouse" => {
            let mut described = Vec::new();
            for (x, y) in pressed_points(input) {
                if let Some(found) = browser.describe_point(tab, x, y).await {
                    described.push(found);
                }
            }
            (!described.is_empty()).then(|| described.join("; "))
        }
        _ => None,
    }
}

/// Where a pointer gesture presses: the point of every `down` and `click`
/// step, a step with no coordinates being where the last one left the
/// pointer. The first few distinct points, which is where a gesture that
/// means something does its pressing.
fn pressed_points(input: &serde_json::Value) -> Vec<(f64, f64)> {
    const MAX_POINTS: usize = 5;
    let mut at: Option<(f64, f64)> = None;
    let mut points: Vec<(f64, f64)> = Vec::new();
    for step in input["steps"].as_array().into_iter().flatten() {
        if let (Some(x), Some(y)) = (step["x"].as_f64(), step["y"].as_f64()) {
            at = Some((x, y));
        }
        let presses = matches!(step["action"].as_str(), Some("down" | "click"));
        if presses
            && let Some(point) = at
            && !points.contains(&point)
        {
            points.push(point);
            if points.len() == MAX_POINTS {
                break;
            }
        }
    }
    points
}

/// Page content comes back fenced, and a page that tried to give the agent
/// orders is reported.
///
/// Any text the browser answered with, from a read or an action, and failures
/// as well: a click reports the name of what it clicked, a failed locator
/// suggests the nearest labels on the page, and a dialog's message is in the
/// error that says it is open -- all of them words the page chose. Only the
/// few tools whose answer no page has a hand in are left bare, and an image
/// is not text a page can hide a sentence in.
fn guard(
    state: &AppState,
    run: &Run,
    on_delta: &Channel<ChatDelta>,
    tab_id: Option<TabId>,
    call: &dive_agent::ToolUse,
    result: dive_agent::ToolResult,
) -> dive_agent::ToolResult {
    if !crate::agent_guard::page_derived(&call.name) {
        return result;
    }
    let serde_json::Value::String(body) = &result.content else {
        return result;
    };
    let source = call.input["url"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            let tab = call.input["tab_id"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .or(tab_id)?;
            lock(&state.store).tab(tab).ok().map(|tab| tab.url)
        })
        .unwrap_or_else(|| "the page".to_owned());
    let attempt = crate::agent_guard::scan(body);
    if let Some(attempt) = &attempt {
        let _ = on_delta.send(ChatDelta::Flagged(format!(
            "{} {}: “{}”",
            host_of(&source),
            attempt.what,
            attempt.quote
        )));
        tracing::warn!(source = %source, what = attempt.what, "a page addressed the agent");
    }
    dive_agent::ToolResult {
        content: serde_json::Value::String(crate::agent_guard::envelope(
            &run.tag,
            &source,
            body,
            attempt.as_ref(),
        )),
        ..result
    }
}

/// `a.dev` for `https://a.dev/x?y`, for a sentence about a page.
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if host.is_empty() {
        "This page".to_owned()
    } else {
        host.to_owned()
    }
}

/// The step as the chrome shows it and the approval judges it.
///
/// Judged on the tab the call acts on, which is not always the one the run
/// started in: a call can name any tab, and a page about money in a second
/// tab is no less expensive for being opened second. `target` is what the
/// host found the call aimed at (see [`resolve_target`]), when it looked.
fn step_for(
    state: &AppState,
    run: &Run,
    tab_id: Option<TabId>,
    call: &dive_agent::ToolUse,
    target: Option<&str>,
) -> ToolStep {
    let locator = locator_for(state, tab_id, &call.input);
    let url = crate::agent_tools::call_tab(tab_id, &call.input)
        .and_then(|tab| lock(&state.store).tab(tab).ok())
        .map(|tab| tab.url)
        .unwrap_or_default();
    let aimed_at = match (locator.as_deref(), target) {
        (Some(locator), Some(target)) => Some(format!("{locator} {target}")),
        (locator, target) => locator.or(target).map(str::to_owned),
    };
    let tainted = run.tainted();
    let seen = run.seen();
    let caution = crate::agent_risk::judge(&crate::agent_risk::Step {
        tool: &call.name,
        input: &call.input,
        target: aimed_at.as_deref(),
        url: &url,
        tainted: &tainted,
        seen: &seen,
    });
    ToolStep {
        id: run.step_id(&call.id),
        name: call.name.clone(),
        input: call.input.to_string(),
        action: crate::agent_tools::is_action(&call.name),
        always: caution.as_ref().is_some_and(|c| c.always),
        caution: caution.map(|c| c.why),
        locator: locator.or_else(|| target.map(str::to_owned)),
    }
}

/// `getByRole('button', { name: 'Save' })` for the ref in `input`, if known.
fn locator_for(
    state: &AppState,
    tab_id: Option<TabId>,
    input: &serde_json::Value,
) -> Option<String> {
    let reference = input["ref"].as_str()?;
    let tab = input["tab_id"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .or(tab_id)?;
    let target = state.buffers.resolve_ref(tab, reference)?;
    Some(playwright_locator(&target.role, &target.name))
}

/// Map an accessibility role and name to a Playwright locator.
pub fn playwright_locator(role: &str, name: &str) -> String {
    let escaped: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != '\u{2028}' && *c != '\u{2029}')
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('\'', "\\'");
    let role = match role {
        "textbox" | "searchbox" => "textbox",
        // The role comes from the page's own `role` attribute. Written into
        // the exported test as-is, a crafted one closed the string and
        // planted code that ran with the test; every ARIA role is plain
        // lowercase letters, so anything else is not a role at all.
        other
            if !other.is_empty()
                && other.len() <= 32
                && other.bytes().all(|b| b.is_ascii_lowercase()) =>
        {
            other
        }
        _ if escaped.is_empty() => return "locator('body')".to_owned(),
        _ => return format!("getByText('{escaped}')"),
    };
    if escaped.is_empty() {
        format!("getByRole('{role}')")
    } else {
        format!("getByRole('{role}', {{ name: '{escaped}' }})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locators_follow_playwright_shape() {
        assert_eq!(
            playwright_locator("link", "Learn more"),
            "getByRole('link', { name: 'Learn more' })"
        );
        assert_eq!(
            playwright_locator("searchbox", "It's here"),
            "getByRole('textbox', { name: 'It\\'s here' })"
        );
        assert_eq!(playwright_locator("button", ""), "getByRole('button')");
        assert_eq!(
            playwright_locator("button", "a\nb\u{2028}c"),
            "getByRole('button', { name: 'abc' })"
        );
        // A role the page made up never reaches the test as code.
        assert_eq!(
            playwright_locator("x'); require('child_process'); ('", "Go"),
            "getByText('Go')"
        );
        assert_eq!(playwright_locator("BUTTON", ""), "locator('body')");
    }

    /// The vectors the TypeScript builder (`lib/playwright.ts`) is tested
    /// against: the two must write the same locator for the same element.
    #[test]
    fn locators_match_the_shared_vectors() {
        let vectors: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../../src/lib/locatorVectors.json"))
                .expect("locatorVectors.json is a JSON array");
        assert!(vectors.len() >= 10, "the vector file looks truncated");
        for v in &vectors {
            let (role, name, expected) = (
                v["role"].as_str().expect("role"),
                v["name"].as_str().expect("name"),
                v["expected"].as_str().expect("expected"),
            );
            assert_eq!(
                playwright_locator(role, name),
                expected,
                "role {role:?}, name {name:?}"
            );
        }
    }

    #[test]
    fn a_gesture_is_judged_where_it_presses() {
        let input = json!({"steps": [
            {"action": "move", "x": 1, "y": 1},
            {"action": "down"},
            {"action": "move", "x": 50, "y": 50},
            {"action": "up"},
            {"action": "click", "x": 90, "y": 10},
            {"action": "click", "x": 90, "y": 10},
            {"action": "wheel", "x": 5, "y": 5, "delta_y": 100},
        ]});
        assert_eq!(pressed_points(&input), [(1.0, 1.0), (90.0, 10.0)]);
        assert!(pressed_points(&json!({})).is_empty());
    }

    #[test]
    fn a_page_is_named_by_its_host_when_it_is_reported() {
        assert_eq!(host_of("https://a.dev/x?y=1"), "a.dev");
        assert_eq!(host_of("https://user@a.dev:8443/x"), "a.dev:8443");
        assert_eq!(host_of("the page"), "the page");
        assert_eq!(host_of(""), "This page");
    }

    // ----- the round loop, with the provider and the tools scripted -----

    use dive_agent::{AgentError, ToolResult, ToolUse};
    use futures_util::stream::{self, BoxStream};
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicUsize;

    /// What one opened stream does.
    enum Script {
        /// Yield these deltas, then end.
        Reply(Vec<Delta>),
        /// Yield these deltas, then never yield again.
        Hang(Vec<Delta>),
        /// Fail to open.
        Fail(AgentError),
    }

    struct ScriptedOpener {
        scripts: Mutex<VecDeque<Script>>,
        opened: AtomicUsize,
    }

    impl ScriptedOpener {
        fn new(scripts: Vec<Script>) -> Self {
            Self {
                scripts: Mutex::new(scripts.into()),
                opened: AtomicUsize::new(0),
            }
        }

        fn opens(&self) -> usize {
            self.opened.load(Ordering::SeqCst)
        }
    }

    impl OpenStream for ScriptedOpener {
        fn open<'a>(
            &'a self,
            _request: &'a dive_agent::Request,
        ) -> futures_util::future::BoxFuture<'a, Result<BoxStream<'static, Delta>, AgentError>>
        {
            self.opened.fetch_add(1, Ordering::SeqCst);
            let script = lock(&self.scripts)
                .pop_front()
                .expect("the loop opened more streams than the test scripted");
            Box::pin(async move {
                match script {
                    Script::Reply(deltas) => Ok(stream::iter(deltas).boxed()),
                    Script::Hang(deltas) => {
                        Ok(stream::iter(deltas).chain(stream::pending()).boxed())
                    }
                    Script::Fail(error) => Err(error),
                }
            })
        }
    }

    /// Announces a plain step and answers every call with "ok", recording
    /// which calls it was asked to run.
    #[derive(Default)]
    struct StubTools {
        rounds: Mutex<Vec<Vec<String>>>,
        /// Answer every call with this instead of "ok" when set.
        payload: Option<String>,
    }

    impl RoundTools for StubTools {
        fn announce(&self, run: &Run, call: &ToolUse) -> ToolStep {
            ToolStep {
                id: run.step_id(&call.id),
                name: call.name.clone(),
                input: call.input.to_string(),
                action: false,
                locator: None,
                caution: None,
                always: false,
            }
        }

        fn run_calls<'a>(
            &'a self,
            _run: &'a Run,
            _on_delta: &'a Channel<ChatDelta>,
            calls: &'a [ToolUse],
        ) -> futures_util::future::BoxFuture<'a, Vec<ToolResult>> {
            lock(&self.rounds).push(calls.iter().map(|c| c.id.clone()).collect());
            let answer = self.payload.clone().unwrap_or_else(|| "ok".into());
            Box::pin(async move {
                calls
                    .iter()
                    .map(|c| ToolResult {
                        tool_use_id: c.id.clone(),
                        content: json!(answer),
                        is_error: false,
                    })
                    .collect()
            })
        }
    }

    type Seen = Arc<Mutex<Vec<ChatDelta>>>;

    /// A channel that keeps every delta sent into it, built the way the
    /// agent probe builds one.
    fn collecting() -> (Channel<ChatDelta>, Seen) {
        let seen: Seen = Arc::default();
        let sink = Arc::clone(&seen);
        let channel = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            if let Ok(delta) = body.deserialize::<ChatDelta>() {
                lock(&sink).push(delta);
            }
            Ok(())
        });
        (channel, seen)
    }

    fn call(id: &str, name: &str) -> ToolUse {
        ToolUse {
            id: id.into(),
            name: name.into(),
            input: json!({}),
        }
    }

    /// One round as the wires emit it: text, calls, usage, the replayable
    /// turn, then the stop reason.
    fn reply(text: &str, calls: &[(&str, &str)], stop: &str) -> Vec<Delta> {
        let mut out = Vec::new();
        let mut blocks = Vec::new();
        if !text.is_empty() {
            out.push(Delta::Text(text.into()));
            blocks.push(json!({"type": "text", "text": text}));
        }
        for (id, name) in calls {
            out.push(Delta::ToolUse(call(id, name)));
            blocks.push(json!({"type": "tool_use", "id": id, "name": name, "input": {}}));
        }
        out.push(Delta::Usage(Usage {
            input_tokens: 10,
            output_tokens: 5,
            ..Usage::default()
        }));
        out.push(Delta::Assistant(Turn::assistant_blocks(blocks)));
        out.push(Delta::Done(stop.into()));
        out
    }

    fn api(status: u16, retry_after: Option<Duration>) -> AgentError {
        AgentError::Api {
            status,
            message: "scripted".into(),
            retry_after,
        }
    }

    fn fresh_request() -> Request {
        Request::new("system", vec![Turn::text(Role::User, "go")])
    }

    /// Run the loop to its end with `max_steps`, returning what came out.
    async fn run_rounds(
        opener: &ScriptedOpener,
        tools: &StubTools,
        request: &mut Request,
        max_steps: usize,
    ) -> Vec<ChatDelta> {
        let run = Run::new("t");
        let (channel, seen) = collecting();
        rounds(opener, request, &run, &channel, max_steps, tools)
            .await
            .unwrap();
        lock(&seen).clone()
    }

    fn last_error(deltas: &[ChatDelta]) -> (&str, FailureKind) {
        match deltas.last() {
            Some(ChatDelta::Error { message, kind }) => (message, *kind),
            other => panic!("the run did not end in an error: {other:?}"),
        }
    }

    fn statuses(deltas: &[ChatDelta]) -> Vec<&str> {
        deltas
            .iter()
            .filter_map(|d| match d {
                ChatDelta::Status(s) => Some(s.as_str()),
                _ => None,
            })
            .collect()
    }

    fn not_run(deltas: &[ChatDelta]) -> Vec<(&str, &str)> {
        deltas
            .iter()
            .filter_map(|d| match d {
                ChatDelta::ToolDone {
                    id,
                    summary,
                    error: true,
                } => Some((id.as_str(), summary.as_str())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_channel_can_be_built_and_read_outside_an_app() {
        let (channel, seen) = collecting();
        channel.send(ChatDelta::Done("end_turn".into())).unwrap();
        assert!(matches!(&lock(&seen)[..], [ChatDelta::Done(r)] if r == "end_turn"));
    }

    #[test]
    fn a_turn_holding_an_image_counts_its_bytes() {
        let data = "A".repeat(1024 * 1024);
        let turn = Turn::tool_results(vec![ToolResult {
            tool_use_id: "a".into(),
            content: json!([{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}}]),
            is_error: false,
        }]);
        assert!(turn_bytes(&turn) >= 1024 * 1024);
    }

    #[tokio::test(start_paused = true)]
    async fn a_run_that_outgrows_the_request_limit_stops_cleanly() {
        let opener = ScriptedOpener::new(vec![Script::Reply(reply(
            "",
            &[("a", "page_text")],
            "tool_use",
        ))]);
        let tools = StubTools {
            payload: Some("x".repeat(25 * 1024 * 1024)),
            ..StubTools::default()
        };
        let mut request = fresh_request();
        let out = run_rounds(&opener, &tools, &mut request, 25).await;
        let (message, kind) = last_error(&out);
        assert!(
            message.contains("more than the provider accepts"),
            "{message}"
        );
        assert_eq!(kind, FailureKind::Other);
        assert_eq!(opener.opens(), 1, "no second request is sent");
    }

    #[tokio::test(start_paused = true)]
    async fn a_reply_without_tool_calls_ends_the_run() {
        let opener = ScriptedOpener::new(vec![Script::Reply(reply("hello", &[], "end_turn"))]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let out = run_rounds(&opener, &tools, &mut request, 25).await;

        assert!(
            matches!(out.last(), Some(ChatDelta::Done(r)) if r == "end_turn"),
            "{out:?}"
        );
        assert_eq!(opener.opens(), 1);
        assert!(lock(&tools.rounds).is_empty());
        assert_eq!(request.turns.len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn tool_rounds_append_the_assistant_turn_and_results() {
        let opener = ScriptedOpener::new(vec![
            Script::Reply(reply(
                "",
                &[("a", "page_text"), ("b", "page_text")],
                "tool_use",
            )),
            Script::Reply(reply("done", &[], "end_turn")),
        ]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let out = run_rounds(&opener, &tools, &mut request, 25).await;

        assert!(
            matches!(out.last(), Some(ChatDelta::Done(r)) if r == "end_turn"),
            "{out:?}"
        );
        assert_eq!(opener.opens(), 2);
        assert_eq!(
            *lock(&tools.rounds),
            vec![vec!["a".to_owned(), "b".to_owned()]]
        );
        assert_eq!(request.turns.len(), 3);
        assert_eq!(request.turns[1].role, Role::Assistant);
        assert_eq!(request.turns[2].role, Role::User);
        let results = request.turns[2].content.as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r["type"] == "tool_result"));
        // Each call was announced as a row before it ran.
        let announced = out
            .iter()
            .filter(|d| matches!(d, ChatDelta::ToolCall(_)))
            .count();
        assert_eq!(announced, 2);
    }

    #[tokio::test(start_paused = true)]
    async fn the_step_limit_counts_calls_not_rounds() {
        let opener = ScriptedOpener::new(vec![
            Script::Reply(reply(
                "",
                &[("a", "page_text"), ("b", "page_text")],
                "tool_use",
            )),
            Script::Reply(reply(
                "",
                &[("c", "page_text"), ("d", "page_text")],
                "tool_use",
            )),
        ]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let out = run_rounds(&opener, &tools, &mut request, 3).await;

        // Two calls fit, the next two would make four.
        assert_eq!(lock(&tools.rounds).len(), 1);
        assert_eq!(opener.opens(), 2);
        let (message, kind) = last_error(&out);
        assert!(
            message.starts_with("Stopped after 3 tool calls"),
            "{message}"
        );
        assert_eq!(kind, FailureKind::Other);
        assert_eq!(
            not_run(&out),
            vec![
                ("t:c", "Not run: the step limit was reached."),
                ("t:d", "Not run: the step limit was reached."),
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_busy_provider_is_retried_then_succeeds() {
        let opener = ScriptedOpener::new(vec![
            Script::Fail(api(529, None)),
            Script::Reply(reply("hi", &[], "end_turn")),
        ]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let out = run_rounds(&opener, &tools, &mut request, 25).await;

        assert_eq!(opener.opens(), 2);
        let status = statuses(&out);
        assert_eq!(status.len(), 1, "{out:?}");
        assert!(status[0].contains("trying again in 1s"), "{}", status[0]);
        assert!(
            matches!(out.last(), Some(ChatDelta::Done(r)) if r == "end_turn"),
            "{out:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn retries_give_up_after_three_attempts() {
        let opener = ScriptedOpener::new(vec![
            Script::Fail(api(503, None)),
            Script::Fail(api(503, None)),
            Script::Fail(api(503, None)),
        ]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let out = run_rounds(&opener, &tools, &mut request, 25).await;

        assert_eq!(opener.opens(), 3);
        assert_eq!(statuses(&out).len(), 2);
        let (message, kind) = last_error(&out);
        assert!(message.contains("503"), "{message}");
        assert_eq!(kind, FailureKind::Other);
    }

    #[tokio::test(start_paused = true)]
    async fn a_bad_key_is_not_retried() {
        let opener = ScriptedOpener::new(vec![Script::Fail(api(401, None))]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let out = run_rounds(&opener, &tools, &mut request, 25).await;

        assert_eq!(opener.opens(), 1);
        assert!(statuses(&out).is_empty());
        assert_eq!(last_error(&out).1, FailureKind::Auth);
    }

    #[tokio::test(start_paused = true)]
    async fn a_config_error_is_not_retried() {
        let opener = ScriptedOpener::new(vec![Script::Fail(AgentError::Config(
            "invalid base URL".into(),
        ))]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let out = run_rounds(&opener, &tools, &mut request, 25).await;

        assert_eq!(opener.opens(), 1);
        assert_eq!(last_error(&out).1, FailureKind::Model);
    }

    #[tokio::test(start_paused = true)]
    async fn an_unanswered_request_is_not_sent_again() {
        let opener = ScriptedOpener::new(vec![Script::Fail(AgentError::Unanswered(
            "request timed out waiting for response headers".into(),
        ))]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let out = run_rounds(&opener, &tools, &mut request, 25).await;

        assert_eq!(opener.opens(), 1);
        assert!(statuses(&out).is_empty());
        assert_eq!(last_error(&out).1, FailureKind::Other);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_during_the_backoff_ends_at_once() {
        let opener =
            ScriptedOpener::new(vec![Script::Fail(api(429, Some(Duration::from_secs(20))))]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let run = Run::new("t");
        let (channel, seen) = collecting();
        let started = tokio::time::Instant::now();
        let (result, ()) = tokio::join!(
            rounds(&opener, &mut request, &run, &channel, 25, &tools),
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                run.cancel();
            }
        );
        result.unwrap();

        let out = lock(&seen).clone();
        assert!(
            matches!(out.last(), Some(ChatDelta::Done(r)) if r == "stopped"),
            "{out:?}"
        );
        assert!(statuses(&out)[0].contains("trying again in 20s"));
        assert_eq!(opener.opens(), 1);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stop_while_the_reply_streams_abandons_the_calls() {
        let opener = ScriptedOpener::new(vec![Script::Hang(vec![Delta::ToolUse(call(
            "a",
            "page_text",
        ))])]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let run = Run::new("t");
        let (channel, seen) = collecting();
        let (result, ()) = tokio::join!(
            rounds(&opener, &mut request, &run, &channel, 25, &tools),
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                run.cancel();
            }
        );
        result.unwrap();

        let out = lock(&seen).clone();
        assert!(
            matches!(out.last(), Some(ChatDelta::Done(r)) if r == "stopped"),
            "{out:?}"
        );
        assert_eq!(
            not_run(&out),
            vec![("t:a", "Not run: the run was stopped.")]
        );
        assert!(lock(&tools.rounds).is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_stream_fails_after_the_idle_timeout() {
        let opener = ScriptedOpener::new(vec![Script::Hang(vec![])]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let out = run_rounds(&opener, &tools, &mut request, 25).await;

        let (message, kind) = last_error(&out);
        assert_eq!(
            message,
            "The provider stopped sending data for two minutes."
        );
        assert_eq!(kind, FailureKind::Other);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stream_that_ends_without_a_stop_reason_is_reported() {
        let opener = ScriptedOpener::new(vec![Script::Reply(vec![Delta::Text("partial".into())])]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let out = run_rounds(&opener, &tools, &mut request, 25).await;

        assert_eq!(
            last_error(&out).0,
            "The provider stream ended before it completed the reply."
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_stream_error_abandons_announced_calls() {
        let opener = ScriptedOpener::new(vec![Script::Reply(vec![
            Delta::ToolUse(call("a", "page_text")),
            Delta::Error("boom".into()),
        ])]);
        let tools = StubTools::default();
        let mut request = fresh_request();
        let out = run_rounds(&opener, &tools, &mut request, 25).await;

        assert_eq!(last_error(&out).0, "boom");
        assert_eq!(not_run(&out), vec![("t:a", "Not run: the reply failed.")]);
        assert!(lock(&tools.rounds).is_empty());
    }

    // ----- what happens to a call, decided apart from the browser -----

    #[test]
    fn a_denied_call_is_refused_with_do_not_retry() {
        assert!(
            refusal(Approval::Denied, false)
                .unwrap()
                .contains("Do not retry it")
        );
    }

    #[test]
    fn an_unanswered_call_names_the_two_minute_wait() {
        assert!(
            refusal(Approval::Unanswered, false)
                .unwrap()
                .contains("2 minutes")
        );
    }

    #[test]
    fn stop_wins_over_an_approval() {
        for approval in [Approval::Allowed, Approval::Denied, Approval::Unanswered] {
            assert_eq!(refusal(approval, true), Some(STOPPED_BEFORE_RUN));
        }
        assert_eq!(
            STOPPED_BEFORE_RUN,
            "The user stopped the run before this ran."
        );
    }

    #[test]
    fn an_allowed_call_is_not_refused() {
        assert_eq!(refusal(Approval::Allowed, false), None);
    }

    #[test]
    fn only_a_successful_run_of_a_tainting_read_taints() {
        let result = |is_error| ToolResult {
            tool_use_id: "a".into(),
            content: json!("x"),
            is_error,
        };
        assert!(leaves_taint(true, &result(false), "page_storage"));
        // A call the host refused never ran, so it read nothing.
        assert!(!leaves_taint(false, &result(false), "page_storage"));
        assert!(!leaves_taint(true, &result(true), "page_storage"));
        assert!(!leaves_taint(true, &result(false), "page_click"));
        // The softer mark follows the same rule for page reads.
        assert!(leaves_sight(true, &result(false), "page_text"));
        assert!(!leaves_sight(false, &result(false), "page_text"));
        assert!(!leaves_sight(true, &result(true), "page_text"));
        assert!(!leaves_sight(true, &result(false), "page_click"));
    }
}
