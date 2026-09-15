//! What Dive knows how to do, as prompts any client can list.
//!
//! The browser's expertise used to live in a skill file people installed by
//! hand from another repository, which meant it drifted from the build and
//! only Claude Code ever had it. A prompt travels over the protocol instead:
//! every connected client can list these, and the text ships with the binary
//! that implements the tools it names.
//!
//! Each one is written as instructions to an agent that already has Dive's
//! tools -- not as a description of the browser.

use rmcp::model::{Prompt, PromptArgument};

/// One workflow, as the client sees it and as the agent receives it.
pub struct Workflow {
    /// Name a client calls it by.
    pub name: &'static str,
    /// One line in the client's prompt list.
    pub description: &'static str,
    /// What the caller has to supply, if anything.
    pub argument: Option<(&'static str, &'static str)>,
    /// The instructions, with `{argument}` where the value goes.
    pub body: &'static str,
}

/// Everything the browser offers to do.
pub const WORKFLOWS: &[Workflow] = &[
    Workflow {
        name: "debug_page",
        description: "Find what is broken on the page in front of the user and say how to fix it.",
        argument: None,
        body: "Work on the active tab in Dive.\n\n\
               1. Call page_report. It is one call and it returns the console errors, the failed \
               requests and the page's state together.\n\
               2. For each real problem, get the evidence before explaining it: network_body for a \
               failed request, console_tail for the surrounding lines, page_inspect when the \
               problem is an element.\n\
               3. Ignore noise: third-party analytics, extension warnings, and anything that does \
               not change what the user sees.\n\n\
               Report each problem as: what breaks for the user, the evidence you saw, and the fix \
               in the code. If nothing is broken, say so plainly rather than listing warnings.",
    },
    Workflow {
        name: "write_test",
        description: "Turn a flow in the browser into a Playwright test that passes.",
        argument: Some((
            "flow",
            "The flow to cover, in plain words: 'log in and add to basket'",
        )),
        body: "Write a Playwright test for this flow in the active Dive tab: {flow}\n\n\
               1. Walk the flow yourself first with page_click, page_type and page_press, calling \
               page_wait_for after anything that starts work. Use page_batch to send a run of \
               steps in one round trip.\n\
               2. Address every element by locator (role=, text=, testid=), never by ref: a ref is \
               a node id and goes stale on the next render, and the test you write must survive a \
               redeploy.\n\
               3. page_locate tells you what a locator actually matches before you commit to it.\n\
               4. Assert with page_expect at each step that matters, not only at the end.\n\n\
               Then write the test file: the same locators, web-first assertions, no arbitrary \
               sleeps. Say which selectors were fragile and what test ids would make them solid.",
    },
    Workflow {
        name: "check_accessibility",
        description: "Audit the page for the accessibility problems that actually block people.",
        argument: None,
        body: "Audit the active tab in Dive.\n\n\
               1. page_inspect gives you the accessibility tree with a locator per element: \
               unnamed controls and unreachable elements show up there.\n\
               2. page_screenshot only when a visual question needs it, such as contrast.\n\
               3. Walk the page with page_press Tab to find keyboard traps and elements that take \
               focus without showing it.\n\n\
               Report in the order a person would hit the problems: blocked (cannot complete the \
               task), hard (can, with difficulty), then polish. Give the fix as code for each, and \
               do not pad the list with automated warnings nobody would notice.",
    },
    Workflow {
        name: "check_responsive",
        description: "Check the page at phone, tablet and desktop sizes and report what breaks.",
        argument: None,
        body: "Check the active tab in Dive at several sizes.\n\n\
               1. page_devices lists the devices; put the tab on a phone, then a tablet, then back \
               to desktop with page_resize.\n\
               2. At each size: page_screenshot, and page_report for anything the layout broke.\n\
               3. Look for content that overflows, is cut off, overlaps, or disappears; tap \
               targets too small to hit; and text that reflows into something unreadable.\n\n\
               Report each problem with the width it happens at and the CSS that causes it. \
               Finish by putting the tab back the size you found it.",
    },
    Workflow {
        name: "fill_and_submit",
        description: "Fill a form correctly and confirm what the site did with it.",
        argument: Some(("what", "What to fill in, and with what")),
        body: "Fill the form in the active Dive tab: {what}\n\n\
               1. page_inspect first: it names every field and gives a locator for each. Do not \
               guess field names from a screenshot.\n\
               2. page_fill_form fills several fields in one call. Use page_batch to add the \
               submit and the wait to the same round trip.\n\
               3. After submitting, page_wait_for the thing that proves it worked -- the \
               confirmation, the redirect, the row appearing -- and page_report if it did not.\n\n\
               Say what you entered, what the site answered, and what evidence you have that it \
               was accepted. Never invent a value for a field the user did not give you: ask.",
    },
    Workflow {
        name: "extract_data",
        description: "Pull structured data off a page, including what is behind pagination.",
        argument: Some(("what", "What to extract, and the shape you want it in")),
        body: "Extract from the active Dive tab: {what}\n\n\
               1. page_markdown keeps the structure -- tables stay tables, links keep their \
               targets -- so it beats page_text for anything you are going to parse.\n\
               2. Long pages are windowed: when a reply ends by telling you there is more, call \
               again with the cursor it gives you rather than assuming you saw everything.\n\
               3. For pagination or infinite scroll, page_scroll then page_diff: the diff tells \
               you what arrived without re-reading the whole page.\n\n\
               Return the data in the shape asked for, and say plainly which fields were missing \
               rather than filling them in.",
    },
];

/// The workflow with this name.
pub fn workflow(name: &str) -> Option<&'static Workflow> {
    WORKFLOWS.iter().find(|w| w.name == name)
}

/// Every workflow as an MCP prompt.
pub fn prompts() -> Vec<Prompt> {
    WORKFLOWS
        .iter()
        .map(|w| {
            let arguments = w.argument.map(|(name, description)| {
                vec![
                    PromptArgument::new(name)
                        .with_description(description)
                        .with_required(true),
                ]
            });
            Prompt::new(w.name, Some(w.description), arguments)
        })
        .collect()
}

/// A workflow's instructions with the caller's value in place.
///
/// A prompt whose argument is missing is still worth sending: the agent is
/// told what it is missing, which beats a protocol error the user never sees.
pub fn render(
    workflow: &Workflow,
    arguments: Option<&serde_json::Map<String, serde_json::Value>>,
) -> String {
    let Some((name, _)) = workflow.argument else {
        return workflow.body.to_owned();
    };
    let value = arguments
        .and_then(|a| a.get(name))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("(the user did not say -- ask them before acting)");
    workflow.body.replace(&format!("{{{name}}}"), value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_workflow_is_listed_and_addressable() {
        assert_eq!(prompts().len(), WORKFLOWS.len());
        for w in WORKFLOWS {
            assert!(workflow(w.name).is_some());
            assert!(!w.description.is_empty());
            // The body must be instructions, not a paragraph about Dive.
            assert!(w.body.len() > 200, "{} is too thin to be useful", w.name);
        }
        assert!(workflow("make_coffee").is_none());
    }

    #[test]
    fn an_argument_lands_in_the_body_and_a_missing_one_is_admitted() {
        let write = workflow("write_test").unwrap();
        let filled = render(
            write,
            Some(
                &serde_json::json!({"flow": "log in and add to basket"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        );
        assert!(filled.contains("log in and add to basket"));
        assert!(!filled.contains("{flow}"));

        let empty = render(write, None);
        assert!(empty.contains("did not say"), "{empty}");
        assert!(!empty.contains("{flow}"));
    }

    #[test]
    fn a_workflow_without_arguments_is_sent_as_written() {
        let debug = workflow("debug_page").unwrap();
        assert_eq!(render(debug, None), debug.body);
    }

    #[test]
    fn the_prompts_declare_the_arguments_they_use() {
        for prompt in prompts() {
            let workflow = workflow(&prompt.name).unwrap();
            match (workflow.argument, prompt.arguments) {
                (Some((name, _)), Some(declared)) => {
                    assert_eq!(declared.len(), 1);
                    assert_eq!(declared[0].name, name);
                    assert_eq!(declared[0].required, Some(true));
                }
                (None, None) => {}
                (argument, declared) => panic!("{}: {argument:?} vs {declared:?}", prompt.name),
            }
        }
    }
}
