//! Loader for the JavaScript Dive injects into pages.
//!
//! The scripts live as real `.js` files under `src-tauri/src/inject/` rather
//! than as Rust string literals, so they can be read, linted, and exercised
//! against a DOM by the frontend test suite (`src/lib/injected.test.ts`)
//! instead of only being asserted on as text.
//!
//! A script declares its dependencies with `// @dive-include <file>` lines.
//! [`build`] resolves those depth-first, drops duplicates, wraps the result
//! in an IIFE, and substitutes `__PLACEHOLDER__` tokens. The IIFE matters:
//! every injected script is re-evaluated before use rather than tracked per
//! document, so leaving `const` declarations at global scope would fail the
//! second evaluation with "identifier has already been declared".

/// Every injectable fragment, by file name.
const FRAGMENTS: &[(&str, &str)] = &[
    ("role-name.js", include_str!("inject/role-name.js")),
    ("actionability.js", include_str!("inject/actionability.js")),
    ("react-context.js", include_str!("inject/react-context.js")),
    ("css-path.js", include_str!("inject/css-path.js")),
    ("locator.js", include_str!("inject/locator.js")),
    ("recorder.js", include_str!("inject/recorder.js")),
    ("credentials.js", include_str!("inject/credentials.js")),
    ("forms.js", include_str!("inject/forms.js")),
    ("picker.js", include_str!("inject/picker.js")),
    ("component.js", include_str!("inject/component.js")),
    ("fill-tab.js", include_str!("inject/fill-tab.js")),
    ("subtitles.js", include_str!("inject/subtitles.js")),
    ("markdown.js", include_str!("inject/markdown.js")),
    ("webapp.js", include_str!("inject/webapp.js")),
    ("webapp-icon.js", include_str!("inject/webapp-icon.js")),
    ("stack.js", include_str!("inject/stack.js")),
    ("color.js", include_str!("inject/color.js")),
    ("agent_glow.js", include_str!("inject/agent_glow.js")),
];

/// Cap on include depth, so a cycle is a test failure rather than a hang.
const MAX_DEPTH: usize = 8;

/// The `// @dive-include ` directive prefix.
const DIRECTIVE: &str = "// @dive-include ";

/// The registry entry for `name`, panicking on a typo so a missing fragment
/// is a test failure rather than a silently empty script in the page.
fn fragment(name: &str) -> (&'static str, &'static str) {
    FRAGMENTS.iter().find(|(n, _)| *n == name).map_or_else(
        || panic!("no injectable script named {name}; add it to FRAGMENTS"),
        |(n, source)| (*n, *source),
    )
}

/// Append `name` and everything it includes to `out`, skipping fragments
/// already present.
fn collect(name: &str, depth: usize, seen: &mut Vec<&'static str>, out: &mut String) {
    assert!(depth < MAX_DEPTH, "@dive-include nested too deep at {name}");
    let (_, source) = fragment(name);
    for line in source.lines() {
        let Some(dependency) = line.trim().strip_prefix(DIRECTIVE) else {
            continue;
        };
        let (resolved, _) = fragment(dependency.trim());
        if seen.contains(&resolved) {
            continue;
        }
        seen.push(resolved);
        collect(resolved, depth + 1, seen, out);
    }
    for line in source.lines() {
        if line.trim().starts_with(DIRECTIVE) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
}

/// Build the script for `entry`, substituting `values` for its placeholders.
///
/// Placeholder values are inserted verbatim, so anything derived from a page
/// or from user input has to arrive already JSON-encoded.
pub fn build(entry: &str, values: &[(&str, String)]) -> String {
    let mut body = String::new();
    let mut seen = vec![fragment(entry).0];
    collect(entry, 0, &mut seen, &mut body);
    for (placeholder, value) in values {
        body = body.replace(placeholder, value);
    }
    debug_assert!(
        !has_unfilled_placeholder(&body),
        "{entry} still has an unfilled __PLACEHOLDER__ token"
    );
    format!("(function () {{\n\"use strict\";\n{body}}})()")
}

/// Globals the web platform and popular frameworks publish that happen to be
/// shaped exactly like a placeholder.
///
/// The convention is `__UPPER_SNAKE__`, and `__NEXT_DATA__` is spelled the
/// same way. A script that reads one of these is not a script with an
/// unfilled placeholder, so they are named here rather than the check being
/// loosened for everything.
const KNOWN_GLOBALS: &[&str] = &[
    "NEXT_DATA",
    "NUXT",
    "SENTRY",
    "REDUX_DEVTOOLS_EXTENSION",
    "REDUX_STORE",
    "APOLLO_CLIENT",
    "REACT_QUERY_STATE",
    "TANSTACK_QUERY_STATE",
    "TURBOPACK",
];

/// Whether any `__UPPER_SNAKE__` token survived substitution.
fn has_unfilled_placeholder(body: &str) -> bool {
    body.split("__").skip(1).step_by(2).any(|token| {
        !token.is_empty()
            && !KNOWN_GLOBALS.contains(&token)
            && token
                .chars()
                .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_includes_before_the_body() {
        let script = build("locator.js", &[("__MAX_CANDIDATES__", "10".into())]);
        let role = script.find("const roleOf").expect("role helper included");
        let engine = script
            .find("window.__diveLocator")
            .expect("locator body present");
        assert!(
            role < engine,
            "an included fragment has to be declared before the body that closes over it"
        );
        assert!(!script.contains(DIRECTIVE), "directives are stripped");
        assert!(
            script.contains("const isEditable"),
            "transitive include missing"
        );
    }

    #[test]
    fn every_fragment_is_wrapped_so_re_evaluation_is_safe() {
        // Injected scripts are re-evaluated before each operation. Top-level
        // `const` would make the second evaluation a SyntaxError.
        for (name, _) in FRAGMENTS {
            let values = [
                ("__MAX_CANDIDATES__", "10".into()),
                ("__NONCE__", "\"n\"".into()),
                ("__BINDING__", "__diveTest".into()),
                ("__MAX_FIELD__", "10".into()),
                ("__ROLE__", "\"button\"".into()),
                ("__AUDIO_BINDING__", "__diveTestAudio".into()),
                ("__MARKDOWN_CAP__", "1000".into()),
                ("__MODE__", "\"palette\"".into()),
                ("__MIN_ICON__", "192".into()),
                ("__ICON_URL__", "\"https://x/i.png\"".into()),
                ("__SIZE__", "512".into()),
                ("__ON__", "true".into()),
            ];
            let script = build(name, &values);
            assert!(script.starts_with("(function () {"), "{name} not wrapped");
            assert!(script.trim_end().ends_with("})()"), "{name} not invoked");
            assert!(
                !has_unfilled_placeholder(&script),
                "{name} has an unfilled placeholder"
            );
        }
    }

    #[test]
    fn placeholders_are_substituted_verbatim() {
        let script = build(
            "recorder.js",
            &[
                ("__NONCE__", "\"abc\"".into()),
                ("__BINDING__", "__diveRecord".into()),
                ("__MAX_FIELD__", "4096".into()),
            ],
        );
        assert!(script.contains("const NONCE = \"abc\";"));
        assert!(script.contains("window.__diveRecord(JSON.stringify(payload))"));
        assert!(script.contains(".slice(0, 4096)"));
    }

    #[test]
    fn a_framework_global_is_not_an_unfilled_placeholder() {
        // `__NEXT_DATA__` is spelled exactly like a placeholder, and a probe
        // that reads it must still compose.
        assert!(!has_unfilled_placeholder("if (window.__NEXT_DATA__) {}"));
        assert!(!has_unfilled_placeholder("window.__SENTRY__"));
        // A real one is still caught in the same script.
        assert!(has_unfilled_placeholder(
            "window.__NEXT_DATA__; const n = __LIMIT__;"
        ));
    }

    #[test]
    fn detects_an_unfilled_placeholder() {
        assert!(has_unfilled_placeholder("const n = __MAX_CANDIDATES__;"));
        // Dive's own page globals are not placeholders.
        assert!(!has_unfilled_placeholder("window.__diveLocator = {}"));
        assert!(!has_unfilled_placeholder(
            "key.startsWith(\"__reactFiber$\")"
        ));
        assert!(!has_unfilled_placeholder("no tokens here"));
    }

    #[test]
    fn shared_fragments_are_declared_once_per_script() {
        // picker.js and locator.js both pull in role-name.js; a duplicate
        // declaration would be a SyntaxError in the page.
        let script = build(
            "picker.js",
            &[
                ("__NONCE__", "\"n\"".into()),
                ("__BINDING__", "__diveTest".into()),
            ],
        );
        assert_eq!(
            script.matches("const roleOf =").count(),
            1,
            "role-name.js was inlined more than once"
        );
        assert_eq!(script.matches("const isVisible =").count(), 1);
    }
}
