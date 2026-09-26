/**
 * The languages page translation offers, and how the browser's own language
 * maps onto them. Shared by the address bar's translate menu and the
 * palette's "Translate this page", which must pick the same target.
 */

/** Languages offered, as the on-device translator names them. */
export const LANGUAGES: readonly (readonly [string, string])[] = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese (Simplified)"],
  ["zh-TW", "Chinese (Traditional)"],
  ["ru", "Russian"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["tr", "Turkish"],
  ["vi", "Vietnamese"],
  ["id", "Indonesian"],
  ["fil", "Filipino"],
];

/** Regions and scripts that write Chinese in traditional characters. */
const TRADITIONAL = new Set(["tw", "hk", "mo", "hant"]);

/**
 * A language tag as the translator is asked for it: the primary language
 * alone, except Chinese, where the script decides what a reader can read.
 * Tagalog is offered under its standard form, Filipino. Empty when the tag
 * names no language.
 */
export function canonicalLanguage(tag: string): string {
  const [primary = "", ...rest] = tag.trim().toLowerCase().split(/[-_]/);
  if (!/^[a-z]{2,3}$/.test(primary)) return "";
  if (primary === "zh") return rest.some((part) => TRADITIONAL.has(part)) ? "zh-TW" : "zh";
  if (primary === "tl") return "fil";
  return primary;
}

/** What the browser is set to, as a language the translator understands. */
export function preferredLanguage(tag = navigator.language): string {
  const code = canonicalLanguage(tag);
  return LANGUAGES.some(([offered]) => offered === code) ? code : "en";
}

/** A language's name for a sentence, or its tag when it is not one offered. */
export function languageName(code: string): string {
  return LANGUAGES.find(([key]) => key === code)?.[1] ?? code;
}

/** Why a translation did not happen, in words worth showing someone. */
export function translationMessage(reason: string | null, from: string | null, target: string | null = null): string {
  switch (reason) {
    case "already":
      return target ? `This page is already in ${languageName(target)}.` : "This page is already in that language.";
    case "no-article":
      return "There is no article on this page to read.";
    case "unsupported":
      return "This build cannot translate pages.";
    case "unsupported-pair":
      return from ? `Dive cannot translate ${languageName(from)} into that language yet.` : "That pair of languages is not available.";
    case "unavailable":
      return "The language could not be downloaded. Check the connection and try again.";
    case "unknown-language":
      return "Dive could not tell what language this page is in.";
    case "empty":
      return "There is nothing on this page to translate.";
    default:
      return "This page could not be translated.";
  }
}
