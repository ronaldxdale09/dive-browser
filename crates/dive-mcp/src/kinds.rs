//! What each tool does to the browser.
//!
//! One table, two readers. Clients see it as MCP tool annotations, which is
//! how a client decides what to auto-approve: a read of the page is not the
//! same risk as a click, and a click is not the same risk as clearing a
//! site's storage. The server reads the same table to decide which calls a
//! tab's lease applies to, so two agents never disagree about what counts as
//! acting.
//!
//! A tool missing from the table is a test failure, not a default.

use rmcp::model::ToolAnnotations;

/// What a tool does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Looks at the browser and changes nothing.
    Read,
    /// Acts on a page or a tab: clicks, types, navigates.
    Act,
    /// Throws something away that the person cannot get back by waiting:
    /// closing a tab, clearing storage, deleting a rule.
    Destructive,
}

impl Kind {
    /// How this reads to a client deciding what to approve.
    pub fn annotations(self, title: &str) -> ToolAnnotations {
        ToolAnnotations::with_title(title.to_owned())
            .read_only(self == Self::Read)
            .destructive(self == Self::Destructive)
    }

    /// Whether a tab's lease applies. Reading a page somebody else is driving
    /// is fine and often the point; acting in it is not.
    pub fn needs_lease(self) -> bool {
        !matches!(self, Self::Read)
    }
}

/// Every tool, by name.
pub const TOOLS: &[(&str, Kind)] = &[
    // Looking.
    ("tabs_list", Kind::Read),
    ("contexts", Kind::Read),
    ("tab_history", Kind::Read),
    ("page_text", Kind::Read),
    ("page_markdown", Kind::Read),
    ("page_screenshot", Kind::Read),
    ("page_state", Kind::Read),
    ("page_inspect", Kind::Read),
    ("page_locate", Kind::Read),
    ("page_snapshot", Kind::Read),
    ("page_diff", Kind::Read),
    ("page_report", Kind::Read),
    ("page_component", Kind::Read),
    ("page_storage", Kind::Read),
    ("page_expect", Kind::Read),
    ("page_wait_for", Kind::Read),
    ("console_tail", Kind::Read),
    ("network_list", Kind::Read),
    ("network_body", Kind::Read),
    ("downloads", Kind::Read),
    ("dev_servers", Kind::Read),
    ("dive_capabilities", Kind::Read),
    ("api_spec", Kind::Read),
    ("rules_list", Kind::Read),
    ("page_pdf", Kind::Read),
    ("tab_leases", Kind::Read),
    // Acting.
    ("tab_open", Kind::Act),
    ("tab_activate", Kind::Act),
    ("tab_navigate", Kind::Act),
    ("context_open", Kind::Act),
    ("page_click", Kind::Act),
    ("page_hover", Kind::Act),
    ("page_select", Kind::Act),
    ("page_fill_form", Kind::Act),
    ("page_upload", Kind::Act),
    ("page_drag", Kind::Act),
    ("page_mouse", Kind::Act),
    ("page_keys", Kind::Act),
    ("page_type", Kind::Act),
    ("page_press", Kind::Act),
    ("page_scroll", Kind::Act),
    ("page_dialog", Kind::Act),
    ("page_resize", Kind::Act),
    ("page_devices", Kind::Act),
    ("page_appearance", Kind::Act),
    ("page_throttle", Kind::Act),
    ("page_storage_set", Kind::Act),
    ("page_evaluate", Kind::Act),
    ("page_batch", Kind::Act),
    ("rules_set", Kind::Act),
    ("tab_claim", Kind::Act),
    ("tab_release", Kind::Act),
    // Throwing away.
    ("tab_close", Kind::Destructive),
    ("context_close", Kind::Destructive),
    ("page_storage_clear", Kind::Destructive),
];

/// What a tool does, or `None` for a name the table does not know.
pub fn kind_of(tool: &str) -> Option<Kind> {
    TOOLS
        .iter()
        .find(|(name, _)| *name == tool)
        .map(|(_, kind)| *kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_are_open_and_only_the_destructive_say_so() {
        assert_eq!(kind_of("page_text"), Some(Kind::Read));
        assert_eq!(kind_of("page_click"), Some(Kind::Act));
        assert_eq!(kind_of("tab_close"), Some(Kind::Destructive));
        assert_eq!(kind_of("page_teleport"), None);

        let read = Kind::Read.annotations("Page text");
        assert_eq!(read.read_only_hint, Some(true));
        assert_eq!(read.destructive_hint, Some(false));
        let act = Kind::Act.annotations("Click");
        assert_eq!(act.read_only_hint, Some(false));
        assert_eq!(act.destructive_hint, Some(false));
        let gone = Kind::Destructive.annotations("Close tab");
        assert_eq!(gone.destructive_hint, Some(true));
    }

    #[test]
    fn a_lease_covers_acting_and_never_looking() {
        assert!(!Kind::Read.needs_lease());
        assert!(Kind::Act.needs_lease());
        assert!(Kind::Destructive.needs_lease());
    }

    #[test]
    fn the_table_names_each_tool_once() {
        let mut names: Vec<&str> = TOOLS.iter().map(|(name, _)| *name).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(names.len(), count, "a tool is listed twice");
    }
}
