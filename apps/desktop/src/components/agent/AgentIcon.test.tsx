import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentIcon } from "./AgentIcon";

describe("AgentIcon", () => {
  it("renders a valid SVG with default size and stroke", () => {
    const { container } = render(<AgentIcon />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("width")).toBe("15");
    expect(svg?.getAttribute("height")).toBe("15");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("applies custom size and class names", () => {
    const { container } = render(<AgentIcon size={24} className="text-highlight" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("24");
    expect(svg?.getAttribute("height")).toBe("24");
    expect(svg?.classList.contains("text-highlight")).toBe(true);
  });

  it("renders hero variant with gradients and radial bloom", () => {
    const { container } = render(<AgentIcon size={36} variant="hero" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    const radial = container.querySelector("radialGradient#dive-agent-hero-glow");
    const linear = container.querySelector("linearGradient#dive-agent-hero-grad");
    expect(radial).toBeTruthy();
    expect(linear).toBeTruthy();
  });

  it("renders glow variant with translucent fill and stroke", () => {
    const { container } = render(<AgentIcon variant="glow" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(container.querySelectorAll("path").length).toBe(2);
  });
});
