import { create } from "zustand";

export interface Skill {
  id: string;
  name: string;
  /** Prompt template; `{url}` and `{title}` are filled from the active tab. */
  prompt: string;
}

const KEY = "dive.skills.v1";

export const DEFAULT_SKILLS: Skill[] = [
  { id: "explain", name: "Explain this page", prompt: "Explain what this page does and how it is built, from a developer's perspective. Be concise." },
  { id: "errors", name: "Diagnose errors", prompt: "Look at the console and failed requests for this page. For each real problem, give the likely cause and a concrete fix." },
  { id: "a11y", name: "Accessibility review", prompt: "Read the page state and point out the most important accessibility problems with specific fixes." },
  { id: "api", name: "Document the API calls", prompt: "From the network list, describe the API endpoints this page uses: method, path, purpose, and response shape." },
  { id: "seo", name: "SEO check", prompt: "Review the page's title, description and headings for search and social sharing. List concrete improvements." },
];

function load(): Skill[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Skill[];
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULT_SKILLS;
}

function save(skills: Skill[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(skills));
  } catch {
    // storage unavailable; keep in memory
  }
}

/** Fill `{url}` / `{title}` placeholders. Pure for tests. */
export function render(prompt: string, ctx: { url?: string | undefined; title?: string | undefined }): string {
  return prompt.replaceAll("{url}", ctx.url ?? "").replaceAll("{title}", ctx.title ?? "");
}

interface SkillsState {
  skills: Skill[];
  add: (name: string, prompt: string) => void;
  remove: (id: string) => void;
  reset: () => void;
}

export const useSkills = create<SkillsState>((set, get) => ({
  skills: load(),
  add: (name, prompt) => {
    const skills = [...get().skills, { id: `s${Date.now()}`, name: name.trim(), prompt: prompt.trim() }];
    save(skills);
    set({ skills });
  },
  remove: (id) => {
    const skills = get().skills.filter((s) => s.id !== id);
    save(skills);
    set({ skills });
  },
  reset: () => {
    save(DEFAULT_SKILLS);
    set({ skills: DEFAULT_SKILLS });
  },
}));
