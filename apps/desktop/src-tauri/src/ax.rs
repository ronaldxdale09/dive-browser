//! Accessibility-tree snapshot for agents: the `Accessibility.getFullAXTree`
//! result compacted into indented lines with stable `ref` ids, the format
//! Playwright MCP and Claude in Chrome converged on. Pure and unit-tested.

use serde_json::Value;

/// Roles that carry no information for an agent and get collapsed.
const SKIP: &[&str] = &[
    "none",
    "presentation",
    "generic",
    "InlineTextBox",
    "LineBreak",
    "StaticText",
];
/// Roles worth a ref because an agent may act on them.
const INTERACTIVE: &[&str] = &[
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "option",
    "menuitem",
    "tab",
    "switch",
    "slider",
    "searchbox",
    "spinbutton",
    "menuitemcheckbox",
    "menuitemradio",
];

/// One flattened node.
#[derive(Debug, Clone, PartialEq)]
pub struct AxNode {
    /// `ref` id, present for interactive nodes.
    pub reference: Option<String>,
    /// Backend DOM node id, used to act on the node later.
    pub backend_node_id: Option<i64>,
    /// ARIA role.
    pub role: String,
    /// Accessible name.
    pub name: String,
    /// Depth for indentation.
    pub depth: usize,
}

/// Flatten the CDP tree (`nodes` array) into ordered nodes with refs.
pub fn flatten(result: &Value) -> Vec<AxNode> {
    let nodes = result["nodes"].as_array().cloned().unwrap_or_default();
    let by_id: std::collections::HashMap<&str, &Value> = nodes
        .iter()
        .filter_map(|n| n["nodeId"].as_str().map(|id| (id, n)))
        .collect();
    let mut out = Vec::new();
    let mut next_ref = 1;
    let Some(root) = nodes.first() else {
        return out;
    };
    walk(root, &by_id, 0, &mut out, &mut next_ref);
    out
}

fn walk(
    node: &Value,
    by_id: &std::collections::HashMap<&str, &Value>,
    depth: usize,
    out: &mut Vec<AxNode>,
    next_ref: &mut u32,
) {
    if node["ignored"].as_bool().unwrap_or(false) {
        descend(node, by_id, depth, out, next_ref);
        return;
    }
    let role = node["role"]["value"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let name = node["name"]["value"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_owned();
    if SKIP.contains(&role.as_str())
        || (name.is_empty() && !INTERACTIVE.contains(&role.as_str()) && !is_structural(&role))
    {
        descend(node, by_id, depth, out, next_ref);
        return;
    }
    let interactive = INTERACTIVE.contains(&role.as_str());
    let reference = interactive.then(|| {
        let r = format!("e{next_ref}");
        *next_ref += 1;
        r
    });
    out.push(AxNode {
        reference,
        backend_node_id: node["backendDOMNodeId"].as_i64(),
        role,
        name,
        depth,
    });
    descend(node, by_id, depth + 1, out, next_ref);
}

fn descend(
    node: &Value,
    by_id: &std::collections::HashMap<&str, &Value>,
    depth: usize,
    out: &mut Vec<AxNode>,
    next_ref: &mut u32,
) {
    if let Some(children) = node["childIds"].as_array() {
        for id in children.iter().filter_map(Value::as_str) {
            if let Some(child) = by_id.get(id) {
                walk(child, by_id, depth, out, next_ref);
            }
        }
    }
}

fn is_structural(role: &str) -> bool {
    matches!(
        role,
        "heading"
            | "navigation"
            | "main"
            | "banner"
            | "contentinfo"
            | "form"
            | "list"
            | "listitem"
            | "table"
            | "row"
            | "cell"
            | "dialog"
            | "region"
            | "article"
            | "img"
            | "paragraph"
    )
}

/// Render nodes as the text an agent reads: `- role "name" [ref=e1]`.
pub fn render(nodes: &[AxNode], max_lines: usize) -> String {
    let mut s = String::new();
    for n in nodes.iter().take(max_lines) {
        s.push_str(&"  ".repeat(n.depth));
        s.push_str("- ");
        s.push_str(&n.role);
        if !n.name.is_empty() {
            s.push_str(" \"");
            s.push_str(&n.name.chars().take(120).collect::<String>());
            s.push('"');
        }
        if let Some(r) = &n.reference {
            s.push_str(" [ref=");
            s.push_str(r);
            s.push(']');
        }
        s.push('\n');
    }
    if nodes.len() > max_lines {
        use std::fmt::Write as _;
        let _ = writeln!(s, "… {} more nodes", nodes.len() - max_lines);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: &str, role: &str, name: &str, children: &[&str], backend: i64) -> Value {
        json!({"nodeId": id, "role": {"value": role}, "name": {"value": name}, "childIds": children, "backendDOMNodeId": backend})
    }

    #[test]
    fn flattens_with_refs_and_skips_noise() {
        let tree = json!({"nodes": [
            node("1", "RootWebArea", "Example", &["2", "3"], 1),
            node("2", "generic", "", &["4"], 2),
            node("4", "heading", "Hello", &["5"], 4),
            node("5", "StaticText", "Hello", &[], 5),
            node("3", "link", "Learn more", &[], 3),
        ]});
        let flat = flatten(&tree);
        let roles: Vec<_> = flat.iter().map(|n| n.role.as_str()).collect();
        assert_eq!(roles, ["RootWebArea", "heading", "link"]);
        assert_eq!(flat[2].reference.as_deref(), Some("e1"));
        assert_eq!(flat[1].reference, None);
        assert_eq!(flat[1].depth, 1, "generic wrapper must not add depth");
        let text = render(&flat, 100);
        assert!(text.contains(
            "- RootWebArea \"Example\"\n  - heading \"Hello\"\n  - link \"Learn more\" [ref=e1]"
        ));
    }

    #[test]
    fn render_truncates() {
        let nodes: Vec<AxNode> = (0..5)
            .map(|i| AxNode {
                reference: None,
                backend_node_id: None,
                role: "button".into(),
                name: i.to_string(),
                depth: 0,
            })
            .collect();
        let text = render(&nodes, 2);
        assert!(text.ends_with("… 3 more nodes\n"));
        assert!(flatten(&json!({})).is_empty());
    }
}
