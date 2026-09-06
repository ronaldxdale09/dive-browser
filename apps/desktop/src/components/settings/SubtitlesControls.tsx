import { Check, Download } from "lucide-react";
import { useEffect } from "react";
import { useBrowser } from "../../store/browser";
import { useSubtitles } from "../../store/subtitles";
import { ipc } from "../../lib/ipc";
import { Icon } from "../Icon";
import { Select, Switch } from "../SettingsFields";

/**
 * Languages the picker offers. English, Japanese and Tagalog lead because
 * they are the ones this feature was asked for first; "Auto-detect" lets the
 * model decide when the speaker's language is not known.
 */
export const LANGUAGES: readonly { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ja", label: "Japanese" },
  { value: "tl", label: "Tagalog" },
  { value: "es", label: "Spanish" },
  { value: "zh", label: "Chinese" },
  { value: "ko", label: "Korean" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "hi", label: "Hindi" },
  { value: "auto", label: "Auto-detect" },
];

/** Bytes as a short "12.3 MB" for a progress read-out. */
function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * The model / language / translate / start-stop controls for live subtitles,
 * shared by the burger-menu dialog and the Settings section so the two stay
 * in step through the one store. `onStarted` lets the dialog close itself
 * after a session begins; the Settings section leaves it out and stays put.
 */
export function SubtitlesControls({ onStarted, autoFocusPrimary }: { onStarted?: () => void; autoFocusPrimary?: React.Ref<HTMLButtonElement> }) {
  const activeTab = useBrowser((s) => s.activeTab);
  const models = useSubtitles((s) => s.models);
  const model = useSubtitles((s) => s.model);
  const language = useSubtitles((s) => s.language);
  const translate = useSubtitles((s) => s.translate);
  const downloading = useSubtitles((s) => s.downloading);
  const active = useSubtitles((s) => s.active);
  const starting = useSubtitles((s) => s.starting);
  const lastCue = useSubtitles((s) => s.lastCue);
  const error = useSubtitles((s) => s.error);
  const setModel = useSubtitles((s) => s.setModel);
  const setLanguage = useSubtitles((s) => s.setLanguage);
  const setTranslate = useSubtitles((s) => s.setTranslate);
  const loadModels = useSubtitles((s) => s.loadModels);
  const download = useSubtitles((s) => s.download);
  const start = useSubtitles((s) => s.start);
  const stop = useSubtitles((s) => s.stop);

  // Refresh the model list and the tab's running state when the controls
  // mount, so they reflect a download or a session begun elsewhere.
  useEffect(() => {
    let cancelled = false;
    void loadModels();
    if (activeTab) {
      void ipc
        .subtitleRunning(activeTab)
        .then((running) => { if (!cancelled) useSubtitles.setState({ active: running }); })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [activeTab, loadModels]);

  const chosen = models.find((m) => m.id === model);
  const canStart = Boolean(activeTab) && Boolean(chosen?.downloaded);

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-2">Transcribes the video playing on this page. It runs on your device — nothing is sent to the cloud.</p>

      {/* Model */}
      <div>
        <h3 className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">Model</h3>
        <div className="mt-1.5 space-y-1.5">
          {models.map((m) => {
            const progress = downloading[m.id];
            const selected = m.id === model;
            return (
              <div key={m.id} className={`rounded-xl border p-2.5 ${selected ? "border-line-2 bg-surface-2" : "border-line"}`}>
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setModel(m.id)}
                    className="grid size-4 shrink-0 place-items-center rounded-full border border-line-2 aria-checked:border-highlight aria-checked:bg-highlight"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`Use ${m.label}`}
                  >
                    {selected && <span className="size-1.5 rounded-full bg-accent-ink" />}
                  </button>
                  <button type="button" onClick={() => setModel(m.id)} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-[13px] text-ink">{m.label}</p>
                    <p className="line-clamp-2 text-[11px] text-ink-3">{m.detail}</p>
                  </button>
                  {m.downloaded ? (
                    <button type="button" disabled={Boolean(progress)} onClick={() => void download(m.id)} title="Verify or repair this model" className="inline-flex shrink-0 items-center gap-1 text-[11px] text-ink-2">
                      <Icon icon={Check} size={12} className="text-highlight" />
                      {progress ? "Verifying…" : "Downloaded"}
                    </button>
                  ) : progress ? (
                    <span className="shrink-0 text-[11px] text-ink-3" role="status">
                      {progress.total ? `${mb(progress.received)} / ${mb(progress.total)}` : `${mb(progress.received)}…`}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void download(m.id)}
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-line-2 px-2.5 text-[11px] text-ink-2 hover:bg-surface-2"
                    >
                      <Icon icon={Download} size={12} />
                      Download ({Math.round(m.size_mb)} MB)
                    </button>
                  )}
                </div>
                {progress && !m.downloaded && (
                  <div
                    className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3"
                    role="progressbar"
                    aria-label={`Downloading ${m.label}`}
                    aria-valuemin={0}
                    aria-valuemax={progress.total ?? undefined}
                    aria-valuenow={progress.total ? progress.received : undefined}
                  >
                    {progress.total ? (
                      <span className="block h-full rounded-full bg-highlight" style={{ width: `${Math.min(100, (progress.received / progress.total) * 100)}%` }} />
                    ) : (
                      <span className="block h-full w-1/3 animate-pulse rounded-full bg-highlight" />
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {models.length === 0 && <p className="text-xs text-ink-3">No models available.</p>}
        </div>
      </div>

      {/* Language */}
      <div className="flex items-center justify-between">
        <label htmlFor="subtitle-language" className="text-[13px] text-ink">
          Language
        </label>
        <Select id="subtitle-language" label="Subtitle language" value={language} onChange={setLanguage} options={LANGUAGES} />
      </div>

      {/* Translate */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] text-ink">Translate to English</p>
          <p className="text-[11px] text-ink-3">Translation to other languages is coming later.</p>
        </div>
        <Switch label="Translate to English" checked={translate} onChange={setTranslate} />
      </div>

      {!activeTab && <p className="text-[11px] text-ink-3">Open a tab with a playing video to turn subtitles on. You can still download models here.</p>}

      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}

      {(active || starting) && (
        <p className="truncate rounded-lg bg-surface-2 px-2.5 py-1.5 text-[11px] text-ink-2" role="status" aria-live="polite">
          {lastCue ? lastCue : "Listening…"}
        </p>
      )}

      <div className="flex items-center gap-2">
        <span className="flex-1" />
        {active ? (
          <button ref={autoFocusPrimary} type="button" onClick={() => void stop()} className="h-8 rounded-full bg-surface-3 px-4 text-xs font-medium text-ink hover:bg-surface-2">
            Stop subtitles
          </button>
        ) : (
          <button
            ref={autoFocusPrimary}
            type="button"
            disabled={!canStart || starting}
            onClick={async () => {
              if (await start()) onStarted?.();
            }}
            className="h-8 rounded-full bg-accent px-4 text-xs font-medium text-accent-ink disabled:opacity-40"
          >
            {starting ? "Loading model…" : "Start subtitles"}
          </button>
        )}
      </div>
    </div>
  );
}
