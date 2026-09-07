import anthropicDark from "../assets/logos/anthropic-dark.svg";
import anthropicLight from "../assets/logos/anthropic-light.svg";
import arc from "../assets/logos/arc.svg";
import brave from "../assets/logos/brave.svg";
import cerebrasDark from "../assets/logos/cerebras-dark.svg";
import cerebrasLight from "../assets/logos/cerebras-light.svg";
import chrome from "../assets/logos/chrome.svg";
import chromium from "../assets/logos/chromium.svg";
import claude from "../assets/logos/claude.svg";
import deepseek from "../assets/logos/deepseek.svg";
import edge from "../assets/logos/edge.svg";
import firefox from "../assets/logos/firefox.svg";
import gemini from "../assets/logos/gemini.svg";
import groq from "../assets/logos/groq.svg";
import mistral from "../assets/logos/mistral.svg";
import ollamaDark from "../assets/logos/ollama-dark.svg";
import ollamaLight from "../assets/logos/ollama-light.svg";
import openaiDark from "../assets/logos/openai-dark.svg";
import openaiLight from "../assets/logos/openai-light.svg";
import openrouterDark from "../assets/logos/openrouter-dark.svg";
import openrouterLight from "../assets/logos/openrouter-light.svg";
import opera from "../assets/logos/opera.svg";
import safari from "../assets/logos/safari.svg";
import togetherDark from "../assets/logos/together-dark.svg";
import togetherLight from "../assets/logos/together-light.svg";
import vivaldi from "../assets/logos/vivaldi.svg";
import xaiDark from "../assets/logos/xai-dark.svg";
import xaiLight from "../assets/logos/xai-light.svg";

/**
 * A brand mark for a light ground and, when the brand draws itself in ink,
 * one for a dark ground. Single-file marks carry their own colours and
 * work on both.
 */
export interface BrandLogo {
  light: string;
  dark?: string;
}

/**
 * The official marks, from svgl.app, for every browser Dive can import
 * from and every service it talks to. One source, so a Chrome mark in the
 * import step is the same Chrome mark anywhere else.
 */
export const BRAND_LOGOS: Record<string, BrandLogo> = {
  chrome: { light: chrome },
  brave: { light: brave },
  edge: { light: edge },
  arc: { light: arc },
  vivaldi: { light: vivaldi },
  opera: { light: opera },
  chromium: { light: chromium },
  firefox: { light: firefox },
  safari: { light: safari },
  anthropic: { light: anthropicLight, dark: anthropicDark },
  claude: { light: claude },
  openai: { light: openaiLight, dark: openaiDark },
  chatgpt: { light: openaiLight, dark: openaiDark },
  gemini: { light: gemini },
  google: { light: gemini },
  ollama: { light: ollamaLight, dark: ollamaDark },
  mistral: { light: mistral },
  deepseek: { light: deepseek },
  groq: { light: groq },
  xai: { light: xaiLight, dark: xaiDark },
  openrouter: { light: openrouterLight, dark: openrouterDark },
  together: { light: togetherLight, dark: togetherDark },
  cerebras: { light: cerebrasLight, dark: cerebrasDark },
};

/** The logo for `id`, if one ships. */
export function brandLogo(id: string): BrandLogo | undefined {
  return BRAND_LOGOS[id];
}
