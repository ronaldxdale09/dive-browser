import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Keep a bad chrome render from turning the entire browser window blank. */
export class ChromeErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Dive chrome render failed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main role="alert" className="grid h-full place-items-center bg-ground p-6 text-ink">
        <div className="w-full max-w-md rounded-2xl border border-line-2 bg-surface p-5 shadow-2xl">
          <p className="text-[10px] font-semibold tracking-[0.14em] text-danger uppercase">Interface recovery</p>
          <h1 className="mt-2 text-base font-semibold">Dive's controls hit a problem</h1>
          <p className="mt-2 text-xs leading-relaxed text-ink-2">
            Your page data is still in the browser engine. Retry the controls, or reload this window if the problem continues.
          </p>
          <pre className="mt-3 max-h-28 overflow-auto rounded-lg bg-ground p-2.5 font-mono text-[10.5px] leading-relaxed text-ink-3 select-text">
            {error.message || error.name}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => window.location.reload()} className="pressable h-8 rounded-lg px-3 text-xs text-ink-2 transition-[background-color,transform] hover:bg-surface-2 hover:text-ink">
              Reload window
            </button>
            <button type="button" onClick={() => this.setState({ error: null })} className="pressable h-8 rounded-lg bg-accent px-3.5 text-xs font-medium text-accent-ink transition-[opacity,transform] hover:opacity-90">
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }
}
