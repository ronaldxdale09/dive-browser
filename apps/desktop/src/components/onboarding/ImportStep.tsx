import { Download } from "lucide-react";
import { useBrowserImport } from "../../store/browserImport";
import { useOnboarding } from "../../store/onboarding";
import { Icon } from "../Icon";
import { ImportPanel } from "../import/ImportPanel";
import { StepActions, stepLabel } from "./Shell";

/**
 * Bring bookmarks and history over from the browser used until now. The
 * panel does the work; this step frames it and lets it be skipped, since
 * a fresh start is a fine answer too.
 */
export function ImportStep() {
  const next = useOnboarding((s) => s.next);
  const outcome = useBrowserImport((s) => s.outcome);
  const sources = useBrowserImport((s) => s.sources);
  const nothing = sources !== null && sources.length === 0;
  return (
    <div>
      <div className="flex items-center gap-4">
        <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-highlight-soft text-highlight">
          <Icon icon={Download} size={24} />
        </span>
        <div className="min-w-0">
          <p className="font-mono text-[10.5px] tracking-[0.18em] text-highlight uppercase">{stepLabel("import")}</p>
          <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em]">Bring your bookmarks, history, passwords and form entries</h2>
          <p className="mt-0.5 text-xs text-ink-3">From the browser you have been using. Nothing there changes, and you can do this later from Settings.</p>
        </div>
      </div>
      <div className="mt-5">
        <ImportPanel />
      </div>
      <StepActions primary="Continue" onPrimary={next} skip={outcome || nothing ? undefined : next} />
    </div>
  );
}
