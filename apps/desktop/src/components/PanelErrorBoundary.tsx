import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

/** An optional tool failing must leave navigation and the surrounding chrome usable. */
export class PanelErrorBoundary extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(`${this.props.label} failed`, error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div role="alert" className="grid h-full min-h-24 place-content-center rounded-2xl border border-line bg-surface p-4 text-sm text-ink-2">
      <p>{this.props.label} is unavailable. You can keep browsing.</p>
    </div>;
  }
}
