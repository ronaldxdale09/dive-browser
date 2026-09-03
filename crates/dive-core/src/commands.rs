//! Every user-facing action is a named command. The palette, keybindings,
//! the agent tool list and the MCP server all enumerate this registry.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use crate::{CoreError, Result};

/// Dotted command identifier such as `tab.close`.
pub type CommandId = String;

/// Where a command applies; used to filter the palette.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CommandScope {
    /// Always available.
    Global,
    /// Needs a focused tab.
    Tab,
    /// Needs a workspace.
    Workspace,
    /// Only inside the agent sidecar.
    Agent,
}

/// Public description of a command, safe to send to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Command {
    /// Identifier, e.g. `tab.new`.
    pub id: CommandId,
    /// Palette label.
    pub title: String,
    /// Default key chord in the UI's notation, e.g. `mod+t`.
    pub keybinding: Option<String>,
    /// Where it applies.
    pub scope: CommandScope,
}

type Handler = dyn Fn(Value) -> std::result::Result<Value, String> + Send + Sync;

struct Entry {
    command: Command,
    handler: Arc<Handler>,
}

/// Thread-safe registry of commands and their handlers.
#[derive(Clone, Default)]
pub struct CommandRegistry {
    entries: Arc<RwLock<BTreeMap<CommandId, Entry>>>,
}

impl CommandRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `command` with `handler`. Fails if the id is taken.
    pub fn register<F>(&self, command: Command, handler: F) -> Result<()>
    where
        F: Fn(Value) -> std::result::Result<Value, String> + Send + Sync + 'static,
    {
        let mut map = self
            .entries
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if map.contains_key(&command.id) {
            return Err(CoreError::DuplicateCommand(command.id));
        }
        map.insert(
            command.id.clone(),
            Entry {
                command,
                handler: Arc::new(handler),
            },
        );
        Ok(())
    }

    /// All commands, sorted by id.
    pub fn list(&self) -> Vec<Command> {
        self.entries
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .map(|e| e.command.clone())
            .collect()
    }

    /// Look up one command's description.
    pub fn get(&self, id: &str) -> Option<Command> {
        self.entries
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .map(|e| e.command.clone())
    }

    /// Run a command by id with JSON `args`.
    pub fn run(&self, id: &str, args: Value) -> Result<Value> {
        let handler = {
            let map = self
                .entries
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            map.get(id).map(|e| Arc::clone(&e.handler))
        }
        .ok_or_else(|| CoreError::NotFound {
            kind: "command",
            id: id.to_owned(),
        })?;
        handler(args).map_err(|message| CoreError::CommandFailed {
            id: id.to_owned(),
            message,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cmd(id: &str) -> Command {
        Command {
            id: id.into(),
            title: id.into(),
            keybinding: None,
            scope: CommandScope::Global,
        }
    }

    #[test]
    fn register_list_run() {
        let reg = CommandRegistry::new();
        reg.register(cmd("tab.new"), |args| Ok(json!({"opened": args["url"]})))
            .unwrap();
        reg.register(cmd("app.quit"), |_| Ok(Value::Null)).unwrap();
        assert_eq!(
            reg.list().iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["app.quit", "tab.new"]
        );
        let out = reg.run("tab.new", json!({"url": "https://a"})).unwrap();
        assert_eq!(out["opened"], "https://a");
    }

    #[test]
    fn duplicate_and_missing_and_failing() {
        let reg = CommandRegistry::new();
        reg.register(cmd("x"), |_| Err("boom".into())).unwrap();
        assert!(matches!(
            reg.register(cmd("x"), |_| Ok(Value::Null)),
            Err(CoreError::DuplicateCommand(_))
        ));
        assert!(matches!(
            reg.run("nope", Value::Null),
            Err(CoreError::NotFound { .. })
        ));
        assert!(matches!(
            reg.run("x", Value::Null),
            Err(CoreError::CommandFailed { .. })
        ));
    }
}
