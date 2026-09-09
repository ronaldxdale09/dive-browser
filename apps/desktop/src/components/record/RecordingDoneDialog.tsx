import { Check, Copy, ExternalLink, FolderOpen, Trash2, Video, Wand2 } from "lucide-react";
import { screenUrl } from "../internal/InternalPage";
import { useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import { captureMediaUrl } from "../../lib/mediaUrl";
import { recordingBytes, recordingClock } from "../../lib/recordingFormat";
import { useCoversContent } from "../../lib/overlay";
import { useFadeClose } from "../../lib/useFadeClose";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useBrowser } from "../../store/browser";
import { useRecording } from "../../store/recording";
import { Icon } from "../Icon";
import { errorMessage } from "../../lib/errors";
import { copyText } from "../../lib/clipboard";

/**
 * The finished recording: watch it, find it, share its path, or throw it
 * away. Opens on its own the moment encoding ends.
 */
export function RecordingDoneDialog() {
  const phase = useRecording((s) => s.phase);
  const result = useRecording((s) => s.result);
  const limitHit = useRecording((s) => s.limitHit);
  const dismiss = useRecording((s) => s.dismiss);
  const deleteResult = useRecording((s) => s.deleteResult);
  const openSetup = useRecording((s) => s.openSetup);
  const open = phase === "done" && result !== null;
  useCoversContent(open);
  const root = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useFocusTrap(root, { active: open, initialFocus: primary });
  const { close, className } = useFadeClose(dismiss);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const previewSource = open ? { path: result.preview ?? result.path, format: result.preview ? "webm" : result.format } : null;
  const [preview, previewFailed] = usePreview(previewSource);

  if (!open || !result) return null;
  const name = result.path.split("/").pop() ?? result.path;
  const notify = (notice: string) => useBrowser.getState().notify(notice, 4000);
  const fail = (e: unknown) => useBrowser.setState({ error: errorMessage(e) });

  return (
    <div ref={root} className={`overlay-backdrop fixed inset-0 z-50 ${className}`} onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Recording saved"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="mx-auto mt-12 flex w-[720px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <header className="flex items-center gap-3 px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-highlight-soft text-highlight">
            <Icon icon={Check} size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Recording saved</h2>
            <p className="truncate font-mono text-[11px] text-ink-3" title={result.path}>
              {name}
            </p>
          </div>
          <dl className="flex shrink-0 gap-4 text-right">
            <Stat label="Length" value={recordingClock(result.duration_secs ?? 0)} />
            <Stat label="Size" value={recordingBytes(result.bytes ?? 0)} />
            <Stat label="Picture" value={`${result.width}×${result.height}`} />
            <Stat label="Format" value={result.format.toUpperCase() + (result.has_audio ? " + mic" : "")} />
          </dl>
        </header>

        <div className="mx-5 grid aspect-video place-items-center overflow-hidden rounded-xl border border-line bg-black">
          {preview.status === "ready" && result.format === "gif" && <img src={preview.url} alt="The recording" onError={previewFailed} className="max-h-full max-w-full" />}
          {preview.status === "ready" && result.format !== "gif" && (
            <video src={preview.url} controls autoPlay playsInline onError={previewFailed} className="max-h-full max-w-full" />
          )}
          {preview.status === "loading" && <p className="text-xs text-ink-3">Loading preview…</p>}
          {preview.status === "unavailable" && (
            <div className="flex flex-col items-center gap-2 text-xs text-ink-3">
              <Icon icon={Video} size={22} />
              <p>{preview.reason}</p>
              <button type="button" onClick={() => ipc.recordingOpen(result.path).catch(fail)} className="rounded-lg bg-surface-2 px-3 py-1.5 text-ink hover:bg-surface-3">
                Open in the system player
              </button>
            </div>
          )}
        </div>
        {limitHit && <p className="mx-5 mt-2 text-[11px] text-ink-3">The recording reached its length limit and stopped on its own.</p>}

        <footer className="flex items-center gap-1.5 px-5 py-4">
          <Action icon={ExternalLink} label="Open" onClick={() => ipc.recordingOpen(result.path).catch(fail)} />
          <Action icon={FolderOpen} label="Show in Finder" onClick={() => ipc.downloadsReveal(result.path).catch(fail)} />
          <Action
            icon={copied ? Check : Copy}
            label={copied ? "Copied" : "Copy path"}
            onClick={() => {
              void copyText(result.path).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          />
          <span className="flex-1" />
          {confirming ? (
            <>
              <span className="text-xs text-ink-2">Delete this recording?</span>
              <button type="button" onClick={() => setConfirming(false)} className="h-8 rounded-lg px-3 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink">
                Keep
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteResult()
                    .then(() => notify("Recording deleted"))
                    .catch(fail);
                }}
                className="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-white hover:brightness-110"
              >
                Delete
              </button>
            </>
          ) : (
            <>
              <Action icon={Trash2} label="Delete" onClick={() => setConfirming(true)} tone="danger" />
              {result.format === "mp4" && (
                <button
                  type="button"
                  onClick={() => {
                    dismiss();
                    void useBrowser.getState().openTab(screenUrl(result.path));
                  }}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-highlight-soft px-3 text-xs font-medium whitespace-nowrap text-highlight hover:brightness-110"
                >
                  <Icon icon={Wand2} size={13} />
                  Edit in DiveScreen
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  dismiss();
                  openSetup();
                }}
                className="h-8 shrink-0 rounded-lg px-3 text-xs whitespace-nowrap text-ink-2 hover:bg-surface-2 hover:text-ink"
              >
                Record another
              </button>
              <button ref={primary} type="button" onClick={close} className="h-8 shrink-0 rounded-lg bg-accent px-4 text-xs font-medium text-accent-ink hover:brightness-110">
                Done
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

type Preview = { status: "loading" } | { status: "ready"; url: string } | { status: "unavailable"; reason: string };

/** Stream the capture from disk and retain a useful fallback if decoding fails. */
function usePreview(result: { path: string; format: string } | null): [Preview, () => void] {
  const [failedPath, setFailedPath] = useState<string | null>(null);
  if (!result) return [{ status: "loading" }, () => undefined];
  if (failedPath === result.path) {
    return [{ status: "unavailable", reason: "Dive could not decode this preview. The recording is still saved and can be opened in your system player." }, () => undefined];
  }
  return [{ status: "ready", url: captureMediaUrl(result.path) }, () => setFailedPath(result.path)];
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] tracking-[0.06em] text-ink-3 uppercase">{label}</dt>
      <dd className="font-mono text-[11px] text-ink">{value}</dd>
    </div>
  );
}

/**
 * A secondary action as an icon with its name in the tooltip and for
 * assistive tech. Seven actions with labels did not fit the footer; the
 * three that matter most keep their words.
 */
function Action({ icon, label, onClick, tone = "quiet" }: { icon: typeof Copy; label: string; onClick: () => void; tone?: "quiet" | "danger" }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={`grid size-8 shrink-0 place-items-center rounded-lg transition-colors hover:bg-surface-2 ${tone === "danger" ? "text-ink-3 hover:text-danger" : "text-ink-2 hover:text-ink"}`}>
      <Icon icon={icon} size={14} />
    </button>
  );
}
