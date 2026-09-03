import type { LucideProps } from "lucide-react";
import { forwardRef } from "react";

export interface AgentIconProps extends LucideProps {
  /** Visual variant: default (toolbar stroke), glow (luminous mint aura), or hero (large animated emblem). */
  variant?: "default" | "glow" | "hero";
}

/**
 * Proprietary Agent icon for Dive.
 *
 * Combines Dive's depth/aperture motif with frontier AI neural spark geometry:
 * - A 4-pointed precision astroid lens with smooth parabolic concave curves
 * - A concentric optical aperture diamond echoing browser inspection
 * - A radiant central neural focal core
 * - Precision diagonal celestial rays at 45°
 *
 * Implements LucideProps so it seamlessly drops into Icon, IconButton, and SettingsDialog.
 */
export const AgentIcon = forwardRef<SVGSVGElement, AgentIconProps>(function AgentIcon(
  { size = 15, strokeWidth = 1.75, className = "", variant = "default", ...rest },
  ref,
) {
  const svgProps = { ...rest };
  delete (svgProps as Record<string, unknown>).absoluteStrokeWidth;
  if (variant === "hero") {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`shrink-0 overflow-visible ${className}`}
        aria-hidden="true"
        {...svgProps}
      >
        <defs>
          <radialGradient id="dive-agent-hero-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--color-highlight, #7fd8c8)" stopOpacity="0.25" />
            <stop offset="65%" stopColor="var(--color-highlight, #7fd8c8)" stopOpacity="0.05" />
            <stop offset="100%" stopColor="var(--color-highlight, #7fd8c8)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="dive-agent-hero-grad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="50%" stopColor="var(--color-highlight, #7fd8c8)" />
            <stop offset="100%" stopColor="#5eead4" />
          </linearGradient>
        </defs>

        {/* Ambient subtle background bloom */}
        <circle cx="12" cy="12" r="11" fill="url(#dive-agent-hero-glow)" />

        {/* Outer precision octagonal lens contour with optical alignment marks */}
        <path
          d="M12 2.5 L18.7 5.3 L21.5 12 L18.7 18.7 L12 21.5 L5.3 18.7 L2.5 12 L5.3 5.3 Z M12 2.5 V5.5 M21.5 12 H18.5 M12 21.5 V18.5 M2.5 12 H5.5"
          fill="url(#dive-agent-hero-grad)"
          fillOpacity="0.15"
          stroke="url(#dive-agent-hero-grad)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Precision aperture diamond */}
        <path
          d="M12 8 L16 12 L12 16 L8 12 Z"
          fill="url(#dive-agent-hero-grad)"
          fillOpacity="0.35"
          stroke="url(#dive-agent-hero-grad)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Central neural core */}
        <circle cx="12" cy="12" r="1.5" fill="#ffffff" />
      </svg>
    );
  }

  if (variant === "glow") {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`shrink-0 overflow-visible ${className}`}
        aria-hidden="true"
        {...svgProps}
      >
        <path
          d="M12 2.5 L18.7 5.3 L21.5 12 L18.7 18.7 L12 21.5 L5.3 18.7 L2.5 12 L5.3 5.3 Z M12 2.5 V5.5 M21.5 12 H18.5 M12 21.5 V18.5 M2.5 12 H5.5"
          fill="currentColor"
          fillOpacity="0.15"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 8 L16 12 L12 16 L8 12 Z"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      </svg>
    );
  }

  // Default clean stroked vector matching Lucide standard
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
      {...svgProps}
    >
      {/* Precision octagonal lens contour with cardinal optical axis ticks */}
      <path d="M12 2.5 L18.7 5.3 L21.5 12 L18.7 18.7 L12 21.5 L5.3 18.7 L2.5 12 L5.3 5.3 Z M12 2.5 V5.5 M21.5 12 H18.5 M12 21.5 V18.5 M2.5 12 H5.5" />
      {/* Concentric optical aperture diamond */}
      <path d="M12 8 L16 12 L12 16 L8 12 Z" />
      {/* Central neural focal core */}
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
});
