//! The providers a person can bring a key for, and how to talk to each.
//!
//! Two wire protocols cover all of them. Anthropic speaks its own Messages
//! API; everyone else -- `OpenAI`, `OpenRouter`, Google's compatibility endpoint,
//! xAI, Groq, Mistral, `DeepSeek`, the inference hosts and the local servers --
//! speaks the `OpenAI` chat-completions shape. The catalog is data on purpose:
//! the chrome renders the same list, so adding a provider is one row here.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Request and response shape a provider speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Wire {
    /// Anthropic Messages API: `POST /v1/messages`, content blocks, `tool_use`.
    Anthropic,
    /// `OpenAI` chat completions: `POST /chat/completions`, `tool_calls`.
    OpenAi,
}

/// A provider in the catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    /// Anthropic, first party.
    Anthropic,
    /// `OpenRouter`: one key, every model.
    Openrouter,
    /// `OpenAI`.
    Openai,
    /// Google Gemini through its OpenAI-compatible endpoint.
    Google,
    /// xAI Grok.
    Xai,
    /// Groq.
    Groq,
    /// Mistral.
    Mistral,
    /// `DeepSeek`.
    Deepseek,
    /// Together AI.
    Together,
    /// Fireworks AI.
    Fireworks,
    /// Cerebras.
    Cerebras,
    /// Ollama, running locally.
    Ollama,
    /// LM Studio, running locally.
    Lmstudio,
    /// Any other OpenAI-compatible server, by base URL.
    Custom,
}

/// Everything the chrome and the client need to know about one provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ProviderInfo {
    /// Stable id, also the preferences value.
    pub id: Provider,
    /// Display name.
    pub name: String,
    /// Protocol.
    pub wire: Wire,
    /// Base URL; the client appends the endpoint path.
    pub base_url: String,
    /// Where to create an API key.
    pub key_url: String,
    /// What a key from this provider starts with, for the placeholder.
    pub key_hint: String,
    /// Whether requests need a key at all. Local servers do not.
    pub needs_key: bool,
    /// Whether `GET /models` answers with something worth showing.
    pub lists_models: bool,
    /// Model chosen when the provider is first selected.
    pub default_model: String,
    /// One line for the picker.
    pub note: String,
}

impl Provider {
    /// Every provider, in the order the chrome shows them.
    pub const ALL: [Self; 14] = [
        Self::Anthropic,
        Self::Openrouter,
        Self::Openai,
        Self::Google,
        Self::Xai,
        Self::Groq,
        Self::Mistral,
        Self::Deepseek,
        Self::Together,
        Self::Fireworks,
        Self::Cerebras,
        Self::Ollama,
        Self::Lmstudio,
        Self::Custom,
    ];

    /// The id as it appears in preferences and the keychain.
    pub fn id_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Openrouter => "openrouter",
            Self::Openai => "openai",
            Self::Google => "google",
            Self::Xai => "xai",
            Self::Groq => "groq",
            Self::Mistral => "mistral",
            Self::Deepseek => "deepseek",
            Self::Together => "together",
            Self::Fireworks => "fireworks",
            Self::Cerebras => "cerebras",
            Self::Ollama => "ollama",
            Self::Lmstudio => "lmstudio",
            Self::Custom => "custom",
        }
    }

    /// Parse a preferences value.
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|p| p.id_str() == s.trim().to_ascii_lowercase())
    }

    /// The catalog row.
    #[allow(clippy::too_many_lines)] // Keeping the catalog declarative makes additions auditable.
    pub fn info(self) -> ProviderInfo {
        let row = |name: &str,
                   wire: Wire,
                   base_url: &str,
                   key_url: &str,
                   key_hint: &str,
                   needs_key: bool,
                   lists_models: bool,
                   default_model: &str,
                   note: &str| ProviderInfo {
            id: self,
            name: name.into(),
            wire,
            base_url: base_url.into(),
            key_url: key_url.into(),
            key_hint: key_hint.into(),
            needs_key,
            lists_models,
            default_model: default_model.into(),
            note: note.into(),
        };
        match self {
            Self::Anthropic => row(
                "Anthropic",
                Wire::Anthropic,
                "https://api.anthropic.com",
                "https://console.anthropic.com/settings/keys",
                "sk-ant-…",
                true,
                true,
                "claude-opus-5",
                "Claude, first party. Best at driving a page.",
            ),
            Self::Openrouter => row(
                "OpenRouter",
                Wire::OpenAi,
                "https://openrouter.ai/api/v1",
                "https://openrouter.ai/settings/keys",
                "sk-or-…",
                true,
                true,
                "anthropic/claude-opus-5",
                "One key for hundreds of models, with per-request cost.",
            ),
            Self::Openai => row(
                "OpenAI",
                Wire::OpenAi,
                "https://api.openai.com/v1",
                "https://platform.openai.com/api-keys",
                "sk-…",
                true,
                true,
                "gpt-5",
                "GPT models.",
            ),
            Self::Google => row(
                "Google Gemini",
                Wire::OpenAi,
                "https://generativelanguage.googleapis.com/v1beta/openai",
                "https://aistudio.google.com/apikey",
                "AIza…",
                true,
                true,
                "gemini-3.8-flash",
                "Gemini, through Google's OpenAI-compatible endpoint.",
            ),
            Self::Xai => row(
                "xAI",
                Wire::OpenAi,
                "https://api.x.ai/v1",
                "https://console.x.ai",
                "xai-…",
                true,
                true,
                "grok-4",
                "Grok models.",
            ),
            Self::Groq => row(
                "Groq",
                Wire::OpenAi,
                "https://api.groq.com/openai/v1",
                "https://console.groq.com/keys",
                "gsk_…",
                true,
                true,
                "openai/gpt-oss-120b",
                "Very fast open models.",
            ),
            Self::Mistral => row(
                "Mistral",
                Wire::OpenAi,
                "https://api.mistral.ai/v1",
                "https://console.mistral.ai/api-keys",
                "",
                true,
                true,
                "mistral-large-latest",
                "Mistral models.",
            ),
            Self::Deepseek => row(
                "DeepSeek",
                Wire::OpenAi,
                "https://api.deepseek.com/v1",
                "https://platform.deepseek.com/api_keys",
                "sk-…",
                true,
                true,
                "deepseek-chat",
                "DeepSeek models.",
            ),
            Self::Together => row(
                "Together AI",
                Wire::OpenAi,
                "https://api.together.xyz/v1",
                "https://api.together.ai/settings/api-keys",
                "",
                true,
                true,
                "meta-llama/Llama-3.3-70B-Instruct-Turbo",
                "Open models, hosted.",
            ),
            Self::Fireworks => row(
                "Fireworks AI",
                Wire::OpenAi,
                "https://api.fireworks.ai/inference/v1",
                "https://fireworks.ai/account/api-keys",
                "fw_…",
                true,
                true,
                "accounts/fireworks/models/kimi-k2-instruct",
                "Open models, hosted.",
            ),
            Self::Cerebras => row(
                "Cerebras",
                Wire::OpenAi,
                "https://api.cerebras.ai/v1",
                "https://cloud.cerebras.ai",
                "csk-…",
                true,
                true,
                "gpt-oss-120b",
                "Very fast open models.",
            ),
            Self::Ollama => row(
                "Ollama",
                Wire::OpenAi,
                "http://127.0.0.1:11434/v1",
                "https://ollama.com/download",
                "",
                false,
                true,
                "qwen3",
                "Local. No key; needs a model that supports tools.",
            ),
            Self::Lmstudio => row(
                "LM Studio",
                Wire::OpenAi,
                "http://127.0.0.1:1234/v1",
                "https://lmstudio.ai",
                "",
                false,
                true,
                "",
                "Local. No key; uses whatever model is loaded.",
            ),
            Self::Custom => row(
                "Custom endpoint",
                Wire::OpenAi,
                "",
                "",
                "",
                false,
                true,
                "",
                "Any OpenAI-compatible server. Set the base URL in Settings.",
            ),
        }
    }

    /// Whether this is a server on this machine, which the chrome may treat
    /// as ready without a key.
    pub fn is_local(self) -> bool {
        matches!(self, Self::Ollama | Self::Lmstudio)
    }
}

/// The whole catalog.
pub fn catalog() -> Vec<ProviderInfo> {
    Provider::ALL.into_iter().map(Provider::info).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_and_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for p in Provider::ALL {
            assert_eq!(Provider::parse(p.id_str()), Some(p));
            assert!(seen.insert(p.id_str()), "{} declared twice", p.id_str());
            // The serde name is the id, so preferences and JSON agree.
            assert_eq!(
                serde_json::to_value(p).unwrap(),
                serde_json::Value::String(p.id_str().into())
            );
        }
        assert_eq!(Provider::parse(" OpenRouter "), Some(Provider::Openrouter));
        assert_eq!(Provider::parse("nope"), None);
    }

    #[test]
    fn hosted_providers_have_a_base_url_and_a_key_page() {
        for p in Provider::ALL {
            let info = p.info();
            if p == Provider::Custom {
                assert!(info.base_url.is_empty());
                continue;
            }
            assert!(info.base_url.starts_with("http"), "{p:?}");
            assert!(
                !info.base_url.ends_with('/'),
                "{p:?} base has a trailing slash"
            );
            assert!(!info.name.is_empty());
            if info.needs_key {
                assert!(info.key_url.starts_with("https://"), "{p:?}");
                assert!(!info.default_model.is_empty(), "{p:?}");
            } else {
                assert!(p.is_local() || p == Provider::Custom);
            }
        }
    }
}
