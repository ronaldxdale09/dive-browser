//! The tool reference in `docs/MCP-TOOLS.md`, rendered from the catalog.
//!
//! The checked-in file is compared with a fresh render by a test; when they
//! differ the test rewrites the file and fails once, so a changed tool can
//! not ship with a stale reference.

use std::fmt::Write as _;

use serde_json::Value;

use super::{CatalogEntry, tool_catalog};
use crate::kinds::{Kind, kind_of};
use crate::server::{DEFAULT_MAX_CHARS, MAX_MAX_CHARS, UNIVERSAL_ARGUMENTS};

/// One line on a universal argument. A new argument in
/// `UNIVERSAL_ARGUMENTS` panics here until it is described.
fn universal_description(name: &str) -> String {
    match name {
        "holder" => "Who is driving. Names the agent for tab leases, so two agents do not act on the same tab at once.".into(),
        "max_chars" => format!(
            "How much text a reader returns. Defaults to {DEFAULT_MAX_CHARS}; at most {MAX_MAX_CHARS}."
        ),
        "cursor" => "Where to continue when a reader's answer was cut at `max_chars`; pass the `next_cursor` it returned.".into(),
        other => panic!("universal argument `{other}` has no description in the tool reference"),
    }
}

fn escape_cell(text: &str) -> String {
    text.replace('|', "\\|").replace('\n', " ")
}

fn first_sentence(text: &str) -> &str {
    let text = text.trim();
    text.find(". ").map_or(text, |end| &text[..=end])
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Read => "read",
        Kind::Act => "act",
        Kind::Destructive => "destructive",
    }
}

/// The text of a schema's type, for the Type column.
fn type_of(schema: &Value, root: &Value) -> String {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let name = reference.rsplit('/').next().unwrap_or(reference);
        let values = root
            .get("$defs")
            .and_then(|defs| defs.get(name))
            .and_then(|def| def.get("enum"))
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" \\| ")
            });
        return match values {
            Some(values) if !values.is_empty() => format!("{name}: {values}"),
            _ => name.to_string(),
        };
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return values
            .iter()
            .map(|v| match v.as_str() {
                Some(s) => format!("`{s}`"),
                None => format!("`{v}`"),
            })
            .collect::<Vec<_>>()
            .join(" \\| ");
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(branches) = schema.get(key).and_then(Value::as_array) {
            return branches
                .iter()
                .map(|branch| type_of(branch, root))
                .collect::<Vec<_>>()
                .join(" \\| ");
        }
    }
    match schema.get("type") {
        Some(Value::String(kind)) if kind == "array" => match schema.get("items") {
            Some(items) => match type_of(items, root).as_str() {
                "see schema" => "array".into(),
                inner => format!("array of {inner}"),
            },
            None => "array".into(),
        },
        Some(Value::String(kind)) => kind.clone(),
        Some(Value::Array(kinds)) => {
            let nullable = kinds.iter().any(|k| k == "null");
            let names: Vec<&str> = kinds
                .iter()
                .filter_map(Value::as_str)
                .filter(|k| *k != "null")
                .collect();
            let mut joined = names.join(" \\| ");
            if nullable {
                joined.push_str(" (nullable)");
            }
            joined
        }
        _ => "see schema".into(),
    }
}

fn render(entries: &[CatalogEntry]) -> String {
    let mut out = String::new();
    out.push_str("# MCP tools\n\n");
    out.push_str(
        "Generated from `dive_mcp::tool_catalog()` by `cargo test -p dive-mcp tool_reference`. Do not edit by hand.\n\n",
    );
    out.push_str("To connect an agent, see [Connect an agent](../README.md#connect-an-agent).\n\n");
    out.push_str("## Universal arguments\n\n");
    out.push_str(
        "The server reads these on any tool, so they are not repeated in each schema.\n\n",
    );
    for name in UNIVERSAL_ARGUMENTS {
        let _ = writeln!(out, "- `{name}`: {}", universal_description(name));
    }
    out.push_str(
        "\n`page_evaluate` is refused unless Dive was started with `DIVE_MCP_ALLOW_EVAL=1`.\n\n",
    );
    out.push_str("## Summary\n\n| Tool | Kind | Summary |\n|---|---|---|\n");
    for entry in entries {
        let kind = kind_of(&entry.name).expect("every catalog tool has a kind");
        let _ = writeln!(
            out,
            "| [`{}`](#{}) | {} | {} |",
            entry.name,
            entry.name,
            kind_name(kind),
            escape_cell(first_sentence(&entry.description)),
        );
    }
    out.push_str("\n## Tools\n");
    for entry in entries {
        let kind = kind_of(&entry.name).expect("every catalog tool has a kind");
        let _ = write!(
            out,
            "\n### {}\n\nKind: {}\n\n{}\n\n",
            entry.name,
            kind_name(kind),
            entry.description.trim(),
        );
        let properties = entry
            .input_schema
            .get("properties")
            .and_then(Value::as_object)
            .filter(|p| !p.is_empty());
        let Some(properties) = properties else {
            out.push_str("No parameters.\n");
            continue;
        };
        let required: Vec<&str> = entry
            .input_schema
            .get("required")
            .and_then(Value::as_array)
            .map(|r| r.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let mut names: Vec<&String> = properties.keys().collect();
        names.sort();
        out.push_str("| Parameter | Type | Required | Description |\n|---|---|---|---|\n");
        for name in names {
            let schema = &properties[name];
            let description = schema
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let _ = writeln!(
                out,
                "| `{name}` | {} | {} | {} |",
                escape_cell(&type_of(schema, &entry.input_schema)),
                if required.contains(&name.as_str()) {
                    "yes"
                } else {
                    "no"
                },
                escape_cell(description),
            );
        }
    }
    out
}

/// Trailing whitespace trimmed on every line, one final newline.
fn normalize(text: &str) -> String {
    let mut out: String = text
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    out.push('\n');
    out
}

#[test]
fn tool_reference_is_current() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/MCP-TOOLS.md");
    let fresh = normalize(&render(&tool_catalog()));
    if std::fs::read_to_string(path).ok().as_deref() != Some(fresh.as_str()) {
        std::fs::write(path, &fresh).expect("write docs/MCP-TOOLS.md");
        panic!(
            "docs/MCP-TOOLS.md was out of date and has been regenerated; review the diff and commit it"
        );
    }
}

#[test]
fn type_of_reads_refs_enums_and_nullables() {
    use serde_json::json;
    let root = json!({"$defs": {"Kind": {"enum": ["a", "b"]}, "Plain": {"type": "object"}}});
    assert_eq!(type_of(&json!({"type": "string"}), &root), "string");
    assert_eq!(
        type_of(&json!({"type": ["string", "null"]}), &root),
        "string (nullable)"
    );
    assert_eq!(
        type_of(&json!({"type": ["integer", "string"]}), &root),
        "integer \\| string"
    );
    assert_eq!(
        type_of(&json!({"$ref": "#/$defs/Kind"}), &root),
        "Kind: a \\| b"
    );
    assert_eq!(type_of(&json!({"$ref": "#/$defs/Plain"}), &root), "Plain");
    assert_eq!(type_of(&json!({"enum": ["x", "y"]}), &root), "`x` \\| `y`");
    assert_eq!(
        type_of(
            &json!({"anyOf": [{"type": "string"}, {"type": "null"}]}),
            &root
        ),
        "string \\| null"
    );
    assert_eq!(
        type_of(
            &json!({"type": "array", "items": {"type": "number"}}),
            &root
        ),
        "array of number"
    );
    assert_eq!(type_of(&json!({}), &root), "see schema");
}
