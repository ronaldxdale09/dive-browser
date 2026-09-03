import type { Provider } from "../../lib/ipc";

interface ProviderLogoProps {
  id: Provider;
  size?: number;
  className?: string;
}

/**
 * Beautiful, authentic brand icons for all supported providers.
 * Designed with Anthropic and OpenAI aesthetic fidelity, styled for Dive chrome.
 */
export function ProviderLogo({ id, size = 18, className = "" }: ProviderLogoProps) {
  switch (id) {
    case "anthropic":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          {/* Claude's signature 8-spoke radiating spark */}
          <path
            d="M12 2.5V21.5M2.5 12H21.5M5.28 5.28L18.72 18.72M18.72 5.28L5.28 18.72"
            stroke="currentColor"
            strokeWidth="3.2"
            strokeLinecap="round"
          />
        </svg>
      );

    case "openai":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          {/* OpenAI iconic rosette / spiral iris */}
          <path
            d="M20.5 10.2A5.2 5.2 0 0 0 17 3.5a5.3 5.3 0 0 0-5.8 1.4 5.3 5.3 0 0 0-6.7 2.4 5.2 5.2 0 0 0-2.3 5.5 5.3 5.3 0 0 0 3.5 6.7 5.3 5.3 0 0 0 5.8-1.4 5.3 5.3 0 0 0 6.7-2.4 5.2 5.2 0 0 0 2.3-5.5Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.75" />
          <path d="M12 7v3M15.5 10l-2.6 1.5M15.5 14l-2.6-1.5M12 17v-3M8.5 14l2.6-1.5M8.5 10l2.6 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );

    case "google":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          {/* Google Gemini 4-pointed radiant spark */}
          <path
            d="M12 2C12 7.5 16.5 12 22 12C16.5 12 12 16.5 12 22C12 16.5 7.5 12 2 12C7.5 12 12 7.5 12 2Z"
            fill="currentColor"
          />
        </svg>
      );

    case "groq":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          {/* Groq high-speed lightning bolt */}
          <path
            d="M13 2L3 14H12L11 22L21 10H12L13 2Z"
            fill="currentColor"
          />
        </svg>
      );

    case "ollama":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          {/* Ollama stylized llama */}
          <path
            d="M9 3v4M15 3v4M8 7h8a2 2 0 0 1 2 2v4a3 3 0 0 1-3 3h-6a3 3 0 0 1-3-3V9a2 2 0 0 1 2-2ZM9 12h.01M15 12h.01M7 16l-2 5M17 16l2 5M11 16v5M13 16v5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );

    case "lmstudio":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          {/* LM Studio isometric weight matrix */}
          <path
            d="M12 3L3 8V16L12 21L21 16V8L12 3Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12 12L3 8M12 12V21M12 12L21 8"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );

    case "openrouter":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          {/* OpenRouter routing paths */}
          <circle cx="5" cy="12" r="2.5" fill="currentColor" />
          <circle cx="19" cy="6" r="2.5" fill="currentColor" />
          <circle cx="19" cy="18" r="2.5" fill="currentColor" />
          <path
            d="M7.5 12H12M12 12L16.5 6M12 12L16.5 18"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );

    case "deepseek":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          {/* DeepSeek leaping oceanic fin */}
          <path
            d="M3 15C6 15 8 13.5 10 11C12 8.5 15 5 21 5C20 9 18 13 14 16C11 18.2 8 19 3 19C4 17.5 4 16.5 3 15Z"
            fill="currentColor"
          />
        </svg>
      );

    case "mistral":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          {/* Mistral stepped orange blocks */}
          <rect x="3" y="16" width="5" height="5" rx="1" fill="currentColor" />
          <rect x="9.5" y="10.5" width="5" height="5" rx="1" fill="currentColor" />
          <rect x="16" y="5" width="5" height="5" rx="1" fill="currentColor" />
        </svg>
      );

    case "xai":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          {/* xAI Grok geometric mark */}
          <path
            d="M4 4L14 14M20 20L10 10M20 4L4 20"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      );

    case "together":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          <circle cx="8" cy="12" r="5" stroke="currentColor" strokeWidth="2" />
          <circle cx="16" cy="12" r="5" stroke="currentColor" strokeWidth="2" />
        </svg>
      );

    case "fireworks":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          <path
            d="M12 3V7M12 17V21M3 12H7M17 12H21M5.6 5.6L8.4 8.4M15.6 15.6L18.4 18.4M5.6 18.4L8.4 15.6M15.6 8.4L18.4 5.6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
        </svg>
      );

    case "cerebras":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M8 4V2M12 4V2M16 4V2M8 22V20M12 22V20M16 22V20M4 8H2M4 12H2M4 16H2M22 8H20M22 12H20M22 16H20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );

    case "custom":
    default:
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`shrink-0 ${className}`}
          aria-hidden="true"
        >
          <path
            d="M7 8L3 12L7 16M17 8L21 12L17 16M14 4L10 20"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

/** Provider badge styling (background color + text accent tint) */
export function getProviderBadgeStyle(id: Provider): { bg: string; text: string; border: string; glow: string } {
  switch (id) {
    case "anthropic":
      return {
        bg: "bg-[#cc785c]/15",
        text: "text-[#e07a5f]",
        border: "border-[#cc785c]/30",
        glow: "hover:border-[#cc785c]/50 hover:shadow-[0_0_12px_rgba(224,122,95,0.2)]",
      };
    case "openai":
      return {
        bg: "bg-[#10a37f]/15",
        text: "text-[#10a37f] dark:text-[#2dd4bf]",
        border: "border-[#10a37f]/30",
        glow: "hover:border-[#10a37f]/50 hover:shadow-[0_0_12px_rgba(16,163,127,0.2)]",
      };
    case "google":
      return {
        bg: "bg-[#4285f4]/15",
        text: "text-[#60a5fa]",
        border: "border-[#4285f4]/30",
        glow: "hover:border-[#4285f4]/50 hover:shadow-[0_0_12px_rgba(66,133,244,0.2)]",
      };
    case "groq":
      return {
        bg: "bg-[#f97316]/15",
        text: "text-[#fb923c]",
        border: "border-[#f97316]/30",
        glow: "hover:border-[#f97316]/50 hover:shadow-[0_0_12px_rgba(249,115,22,0.2)]",
      };
    case "ollama":
      return {
        bg: "bg-highlight-soft",
        text: "text-highlight",
        border: "border-highlight/30",
        glow: "hover:border-highlight/50 hover:shadow-[0_0_12px_rgba(127,216,200,0.2)]",
      };
    case "lmstudio":
      return {
        bg: "bg-[#8b5cf6]/15",
        text: "text-[#a78bfa]",
        border: "border-[#8b5cf6]/30",
        glow: "hover:border-[#8b5cf6]/50 hover:shadow-[0_0_12px_rgba(139,92,246,0.2)]",
      };
    case "openrouter":
      return {
        bg: "bg-[#6366f1]/15",
        text: "text-[#818cf8]",
        border: "border-[#6366f1]/30",
        glow: "hover:border-[#6366f1]/50 hover:shadow-[0_0_12px_rgba(99,102,241,0.2)]",
      };
    case "deepseek":
      return {
        bg: "bg-[#0284c7]/15",
        text: "text-[#38bdf8]",
        border: "border-[#0284c7]/30",
        glow: "hover:border-[#0284c7]/50 hover:shadow-[0_0_12px_rgba(2,132,199,0.2)]",
      };
    case "mistral":
      return {
        bg: "bg-[#ea580c]/15",
        text: "text-[#fb923c]",
        border: "border-[#ea580c]/30",
        glow: "hover:border-[#ea580c]/50 hover:shadow-[0_0_12px_rgba(234,88,12,0.2)]",
      };
    case "xai":
      return {
        bg: "bg-surface-3",
        text: "text-ink",
        border: "border-line-2",
        glow: "hover:border-ink-3 hover:shadow-[0_0_12px_rgba(255,255,255,0.1)]",
      };
    case "together":
      return {
        bg: "bg-[#3b82f6]/15",
        text: "text-[#60a5fa]",
        border: "border-[#3b82f6]/30",
        glow: "hover:border-[#3b82f6]/50 hover:shadow-[0_0_12px_rgba(59,130,246,0.2)]",
      };
    case "fireworks":
      return {
        bg: "bg-[#f43f5e]/15",
        text: "text-[#fb7185]",
        border: "border-[#f43f5e]/30",
        glow: "hover:border-[#f43f5e]/50 hover:shadow-[0_0_12px_rgba(244,63,94,0.2)]",
      };
    case "cerebras":
      return {
        bg: "bg-[#ec4899]/15",
        text: "text-[#f472b6]",
        border: "border-[#ec4899]/30",
        glow: "hover:border-[#ec4899]/50 hover:shadow-[0_0_12px_rgba(236,72,153,0.2)]",
      };
    case "custom":
    default:
      return {
        bg: "bg-surface-3",
        text: "text-ink-2",
        border: "border-line",
        glow: "hover:border-line-2",
      };
  }
}
