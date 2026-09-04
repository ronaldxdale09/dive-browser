import {
  ArrowUpRight, Check, Copy, Crop, Download, EyeOff, FolderOpen, Highlighter,
  ImageDown, Minus, Pencil, Plus, Redo2, RotateCcw, Square, Type, Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { Icon } from "../Icon";

type Tool = "crop" | "rect" | "arrow" | "pen" | "highlight" | "text" | "blur";
type Point = { x: number; y: number };
type Region = { x1: number; y1: number; x2: number; y2: number };
type Mark = Region & { kind: Exclude<Tool, "crop">; color: string; width: number; points?: Point[]; text?: string };
type Operation = Mark | (Region & { kind: "crop" });
type CaptureStudioProps = { src: string | null; sourceUrl: string | null; sourceTitle: string | null };

const COLORS = ["#ef4444", "#f59e0b", "#3b82f6", "#22c55e", "#ffffff", "#111827"];
const TOOLS: { id: Tool; label: string; icon: typeof Crop }[] = [
  { id: "crop", label: "Crop", icon: Crop },
  { id: "rect", label: "Rectangle", icon: Square },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight },
  { id: "pen", label: "Pen", icon: Pencil },
  { id: "highlight", label: "Highlight", icon: Highlighter },
  { id: "text", label: "Text", icon: Type },
  { id: "blur", label: "Blur sensitive content", icon: EyeOff },
];

/** Dive's local, full-resolution screenshot workspace. */
export function CaptureStudio({ src, sourceUrl, sourceTitle }: CaptureStudioProps) {
  const title = sourceTitle || sourceUrl || src?.split("/").pop() || "Full-page capture";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(() => src ? null : "This capture has no source file.");
  const [tool, setTool] = useState<Tool>("rect");
  const [color, setColor] = useState(COLORS[0] ?? "#ef4444");
  const [width, setWidth] = useState(5);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [redo, setRedo] = useState<Operation[]>([]);
  const [draft, setDraft] = useState<Operation | null>(null);
  const [textAt, setTextAt] = useState<Point | null>(null);
  // "fit" follows the width of the viewing area so the whole page is in
  // view without hiding under the settings panel; a number is a zoom the
  // person chose with the footer controls.
  const [zoomMode, setZoomMode] = useState<number | "fit">("fit");
  const [areaWidth, setAreaWidth] = useState(0);
  const areaRef = useRef<HTMLElement>(null);
  const zoom = image ? fitZoom(zoomMode, areaWidth, image.naturalWidth) : 1;
  const setZoom = useCallback((update: (current: number) => number) => setZoomMode(Math.round(update(zoom) * 100) / 100), [zoom]);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pdfSize, setPdfSize] = useState<"continuous" | "a4" | "letter">("continuous");

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) => entry && setAreaWidth(entry.contentRect.width));
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!src) return;
    let alive = true;
    void ipc.captureRead(src).then((base64) => {
      const next = new Image();
      next.onload = () => alive && setImage(next);
      next.onerror = () => alive && setLoadError("Dive could not decode this capture. The original file is still safe.");
      next.src = `data:image/png;base64,${base64}`;
    }, (cause) => alive && setLoadError(message(cause)));
    return () => { alive = false; };
  }, [src]);

  const cropRegion = useMemo(() => {
    const crop = [...operations].reverse().find((operation) => operation.kind === "crop");
    return crop ? normalized(crop) : null;
  }, [operations]);
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    for (const operation of draft ? [...operations, draft] : operations) if (operation.kind !== "crop") drawMark(ctx, canvas, operation);
    const crop = draft?.kind === "crop" ? normalized(draft) : cropRegion;
    if (crop) drawCrop(ctx, canvas, crop);
  }, [cropRegion, draft, image, operations]);
  useEffect(paint, [paint]);

  const undoOne = useCallback(() => setOperations((current) => {
    const last = current.at(-1);
    if (!last) return current;
    setRedo((next) => [...next, last]);
    return current.slice(0, -1);
  }), []);
  const redoOne = useCallback(() => setRedo((current) => {
    const last = current.at(-1);
    if (!last) return current;
    setOperations((next) => [...next, last]);
    return current.slice(0, -1);
  }), []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (textAt) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redoOne(); else undoOne(); }
      if (event.key === "+" || event.key === "=") setZoom((value) => Math.min(2, value + 0.1));
      if (event.key === "-") setZoom((value) => Math.max(0.2, value - 0.1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [redoOne, setZoom, textAt, undoOne]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * event.currentTarget.width, y: ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * event.currentTarget.height };
  };
  const onDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const start = point(event);
    if (tool === "text") { setTextAt(start); return; }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraft(tool === "crop"
      ? { kind: "crop", x1: start.x, y1: start.y, x2: start.x, y2: start.y }
      : tool === "pen" || tool === "highlight"
        ? { kind: tool, color, width, x1: start.x, y1: start.y, x2: start.x, y2: start.y, points: [start] }
        : { kind: tool, color, width, x1: start.x, y1: start.y, x2: start.x, y2: start.y });
  };
  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draft) return;
    const next = point(event);
    setDraft({ ...draft, x2: next.x, y2: next.y, ...(draft.kind === "pen" || draft.kind === "highlight" ? { points: [...(draft.points ?? []), next] } : {}) });
  };
  const onUp = () => {
    if (draft && validRegion(draft)) { setOperations((current) => [...current, draft]); setRedo([]); }
    setDraft(null);
  };
  const commitText = (value: string) => {
    if (textAt && value.trim()) {
      setOperations((current) => [...current, { kind: "text", color, width, x1: textAt.x, y1: textAt.y, x2: textAt.x, y2: textAt.y, text: value.trim() }]);
      setRedo([]);
    }
    setTextAt(null);
  };

  const output = () => {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("The capture is not ready yet.");
    const crop = cropRegion ?? { x: 0, y: 0, width: canvas.width, height: canvas.height };
    const result = document.createElement("canvas");
    result.width = Math.max(1, Math.round(crop.width)); result.height = Math.max(1, Math.round(crop.height));
    const ctx = result.getContext("2d");
    if (!ctx) throw new Error("Canvas export is unavailable.");
    ctx.drawImage(image ?? canvas, -crop.x, -crop.y);
    if (image) for (const operation of operations) if (operation.kind !== "crop") drawMark(ctx, result, offsetMark(operation, crop.x, crop.y));
    return result;
  };
  const copy = async () => {
    setBusy("copy");
    try {
      await ipc.captureSave(output().toDataURL("image/png").split(",")[1] ?? "");
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    } catch (cause) { useBrowser.setState({ error: message(cause) }); }
    finally { setBusy(null); }
  };
  const exportAs = async (format: "png" | "jpeg" | "pdf") => {
    setBusy(format);
    try {
      const canvas = output(); const name = captureName(sourceTitle || sourceUrl || "capture");
      const filename = `${name}.${format === "jpeg" ? "jpg" : format}`;
      if (format === "pdf") download(await canvasPdf(canvas, pdfSize), filename);
      else download(await canvasBlob(canvas, `image/${format}`, format === "jpeg" ? 0.92 : undefined), filename);
      useBrowser.setState({ notice: `Exported ${filename}` });
      setTimeout(() => useBrowser.setState({ notice: null }), 4000);
    } catch (cause) { useBrowser.setState({ error: message(cause) }); }
    finally { setBusy(null); }
  };

  return (
    <main aria-label="Capture editor" className="flex h-full min-h-0 flex-col bg-ground text-ink">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line-2 bg-surface-2 px-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-highlight-soft text-highlight"><Icon icon={ImageDown} size={16} /></span>
        <div className="mr-2 min-w-0 flex-1"><h1 className="truncate text-sm font-semibold">{title}</h1><p className="truncate text-[11px] text-ink-3">{sourceUrl || "Full-page capture"}</p></div>
        <Action label={copied ? "Copied" : "Copy"} icon={copied ? Check : Copy} disabled={!image || busy !== null} onClick={() => void copy()} />
        <Action label="Export PNG" short="PNG" icon={Download} disabled={!image || busy !== null} onClick={() => void exportAs("png")} />
        <Action label="Export JPEG" short="JPEG" icon={Download} disabled={!image || busy !== null} onClick={() => void exportAs("jpeg")} />
        <select aria-label="PDF page size" value={pdfSize} onChange={(event) => setPdfSize(event.target.value as typeof pdfSize)} className="h-8 rounded-l-lg border border-line-2 bg-surface-3 px-2 text-[11px] text-ink outline-none"><option value="continuous">Continuous PDF</option><option value="a4">A4 pages</option><option value="letter">Letter pages</option></select>
        <Action label="Export PDF" short="PDF" icon={Download} primary joined disabled={!image || busy !== null} onClick={() => void exportAs("pdf")} />
      </header>
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Editing tools" className="flex w-[72px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-3">
          {TOOLS.map((item) => <ToolButton key={item.id} {...item} active={tool === item.id} onClick={() => setTool(item.id)} />)}
          <span className="my-1 h-px w-8 bg-line" />
          <ToolButton label="Undo" icon={Undo2} disabled={operations.length === 0} onClick={undoOne} />
          <ToolButton label="Redo" icon={Redo2} disabled={redo.length === 0} onClick={redoOne} />
          <ToolButton label="Reset edits" icon={RotateCcw} disabled={operations.length === 0} onClick={() => { setOperations([]); setRedo([]); }} />
        </aside>
        <section ref={areaRef} className="relative min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_center,var(--color-surface-2),var(--color-ground)_70%)] p-8">
          {loadError && <div role="alert" className="mx-auto mt-20 max-w-md rounded-xl border border-danger/30 bg-danger/10 p-5 text-sm text-danger">{loadError}</div>}
          {!image && !loadError && <div role="status" className="mx-auto mt-20 w-fit rounded-full border border-line bg-surface px-4 py-2 text-xs text-ink-3">Loading full-resolution capture…</div>}
          {image && <div className="relative mx-auto w-fit shadow-2xl" style={{ width: image.naturalWidth * zoom }}>
            <canvas ref={canvasRef} role="img" aria-label="Full-page capture preview" width={image.naturalWidth} height={image.naturalHeight} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDraft(null)} className="block w-full touch-none bg-white" style={{ cursor: tool === "text" ? "text" : "crosshair" }} />
            {textAt && <input autoFocus aria-label="Annotation text" placeholder="Type a note…" className="absolute min-w-40 rounded-md border border-highlight bg-surface px-2 py-1 text-xs text-ink shadow-xl outline-none" style={{ left: `${(textAt.x / image.naturalWidth) * 100}%`, top: `${(textAt.y / image.naturalHeight) * 100}%` }} onKeyDown={(event) => { if (event.key === "Enter") commitText(event.currentTarget.value); if (event.key === "Escape") setTextAt(null); }} onBlur={(event) => commitText(event.currentTarget.value)} />}
          </div>}
        </section>
        <aside aria-label="Tool settings" className="flex w-52 shrink-0 flex-col border-l border-line bg-surface p-4">
          <h2 className="text-xs font-semibold">{TOOLS.find((item) => item.id === tool)?.label}</h2><p className="mt-1 text-[11px] leading-relaxed text-ink-3">{toolHint(tool)}</p>
          {tool !== "crop" && tool !== "blur" && <><label className="mt-5 text-[10px] font-medium tracking-wider text-ink-3 uppercase">Color</label><div className="mt-2 flex flex-wrap gap-2">{COLORS.map((choice) => <button key={choice} type="button" aria-label={`Color ${choice}`} aria-pressed={color === choice} onClick={() => setColor(choice)} className="size-6 rounded-full border border-line-2 aria-pressed:ring-2 aria-pressed:ring-highlight" style={{ background: choice }} />)}</div><label htmlFor="capture-stroke" className="mt-5 flex justify-between text-[10px] font-medium tracking-wider text-ink-3 uppercase"><span>Stroke</span><span>{width}px</span></label><input id="capture-stroke" aria-label="Stroke width" type="range" min="2" max="20" value={width} onChange={(event) => setWidth(Number(event.target.value))} className="mt-2 accent-[var(--color-highlight)]" /></>}
          <div className="mt-auto space-y-2 border-t border-line pt-4 text-[11px] text-ink-3">{image && <p>{image.naturalWidth.toLocaleString()} × {image.naturalHeight.toLocaleString()} px</p>}{cropRegion && <p className="text-highlight">Crop: {Math.round(cropRegion.width)} × {Math.round(cropRegion.height)} px</p>}<button type="button" disabled={!src} onClick={() => src && void ipc.downloadsReveal(src)} className="flex items-center gap-1.5 text-ink-2 hover:text-ink disabled:opacity-40"><Icon icon={FolderOpen} size={13} /> Original in Finder</button></div>
        </aside>
      </div>
      <footer className="flex h-10 shrink-0 items-center gap-2 border-t border-line bg-surface px-4 text-[11px] text-ink-3"><span>{operations.length} edit{operations.length === 1 ? "" : "s"}</span><span className="flex-1 text-center">Everything stays on this Mac</span><button type="button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.1, value - 0.1))} className="grid size-7 place-items-center rounded-full hover:bg-surface-2"><Icon icon={Minus} size={13} /></button><button type="button" aria-label={zoomMode === "fit" ? "Fitted to width; click for actual size" : "Fit to width"} aria-pressed={zoomMode === "fit"} onClick={() => setZoomMode(zoomMode === "fit" ? 1 : "fit")} className="min-w-12 rounded px-1.5 py-1 text-center hover:bg-surface-2 aria-pressed:text-ink">{zoomMode === "fit" ? `Fit · ${Math.round(zoom * 100)}%` : `${Math.round(zoom * 100)}%`}</button><button type="button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(2, value + 0.1))} className="grid size-7 place-items-center rounded-full hover:bg-surface-2"><Icon icon={Plus} size={13} /></button></footer>
    </main>
  );
}

function ToolButton({ label, icon, active = false, disabled = false, onClick }: { label: string; icon: typeof Crop; active?: boolean; disabled?: boolean; onClick: () => void }) { return <button type="button" aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick} className="grid size-10 place-items-center rounded-xl text-ink-3 hover:bg-surface-2 hover:text-ink disabled:opacity-30 aria-pressed:bg-highlight-soft aria-pressed:text-highlight"><Icon icon={icon} size={16} /></button>; }
function Action({ label, short, icon, onClick, disabled, primary = false, joined = false }: { label: string; short?: string; icon: typeof Download; onClick: () => void; disabled: boolean; primary?: boolean; joined?: boolean }) { return <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className={`flex h-8 items-center gap-1.5 px-3 text-xs font-medium disabled:opacity-40 ${joined ? "-ml-2 rounded-r-lg" : "rounded-lg"} ${primary ? "bg-accent text-accent-ink hover:brightness-105" : "border border-line-2 bg-surface-3 text-ink hover:brightness-125"}`}><Icon icon={icon} size={13} />{short ?? label}</button>; }
/** Padding the viewing area keeps around the page (Tailwind `p-8` on both sides). */
const AREA_PADDING = 64;

/** The zoom `mode` resolves to for a page `imageWidth` wide in an area `areaWidth` wide. Fit never enlarges past 100%. */
export function fitZoom(mode: number | "fit", areaWidth: number, imageWidth: number): number {
  if (mode !== "fit") return mode;
  if (areaWidth <= 0 || imageWidth <= 0) return 1;
  return Math.min(1, Math.max(0.05, (areaWidth - AREA_PADDING) / imageWidth));
}

function validRegion(region: Region): boolean { return Math.abs(region.x2 - region.x1) > 3 || Math.abs(region.y2 - region.y1) > 3; }
function normalized(region: Region) { return { x: Math.min(region.x1, region.x2), y: Math.min(region.y1, region.y2), width: Math.abs(region.x2 - region.x1), height: Math.abs(region.y2 - region.y1) }; }
function offsetMark(mark: Mark, x: number, y: number): Mark {
  const shifted = { ...mark, x1: mark.x1 - x, x2: mark.x2 - x, y1: mark.y1 - y, y2: mark.y2 - y };
  return mark.points ? { ...shifted, points: mark.points.map((point) => ({ x: point.x - x, y: point.y - y })) } : shifted;
}

function drawCrop(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, crop: ReturnType<typeof normalized>) {
  ctx.save(); ctx.fillStyle = "rgba(0,0,0,.58)"; ctx.fillRect(0, 0, canvas.width, crop.y); ctx.fillRect(0, crop.y, crop.x, crop.height); ctx.fillRect(crop.x + crop.width, crop.y, canvas.width - crop.x - crop.width, crop.height); ctx.fillRect(0, crop.y + crop.height, canvas.width, canvas.height - crop.y - crop.height); ctx.strokeStyle = "#fff"; ctx.lineWidth = Math.max(2, canvas.width / 600); ctx.setLineDash([ctx.lineWidth * 3, ctx.lineWidth * 2]); ctx.strokeRect(crop.x, crop.y, crop.width, crop.height); ctx.restore();
}
function drawMark(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, mark: Mark) {
  const line = mark.width * Math.max(1, canvas.width / 1200); ctx.save(); ctx.strokeStyle = mark.color; ctx.fillStyle = mark.color; ctx.lineWidth = line; ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (mark.kind === "rect") ctx.strokeRect(mark.x1, mark.y1, mark.x2 - mark.x1, mark.y2 - mark.y1);
  if (mark.kind === "arrow") { const angle = Math.atan2(mark.y2 - mark.y1, mark.x2 - mark.x1); const head = line * 4; ctx.beginPath(); ctx.moveTo(mark.x1, mark.y1); ctx.lineTo(mark.x2, mark.y2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(mark.x2, mark.y2); ctx.lineTo(mark.x2 - head * Math.cos(angle - Math.PI / 6), mark.y2 - head * Math.sin(angle - Math.PI / 6)); ctx.lineTo(mark.x2 - head * Math.cos(angle + Math.PI / 6), mark.y2 - head * Math.sin(angle + Math.PI / 6)); ctx.closePath(); ctx.fill(); }
  if (mark.kind === "pen" || mark.kind === "highlight") { ctx.globalAlpha = mark.kind === "highlight" ? 0.34 : 1; ctx.lineWidth = mark.kind === "highlight" ? line * 4 : line; ctx.beginPath(); for (const [index, point] of (mark.points ?? []).entries()) { if (index === 0) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y); } ctx.stroke(); }
  if (mark.kind === "text") { const size = Math.max(18, line * 5); ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`; ctx.lineWidth = Math.max(2, size / 8); ctx.strokeStyle = "rgba(0,0,0,.72)"; ctx.strokeText(mark.text ?? "", mark.x1, mark.y1 + size); ctx.fillText(mark.text ?? "", mark.x1, mark.y1 + size); }
  if (mark.kind === "blur") pixelate(ctx, canvas, normalized(mark)); ctx.restore();
}
function pixelate(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, region: ReturnType<typeof normalized>) { if (region.width < 1 || region.height < 1) return; const sample = document.createElement("canvas"); const block = Math.max(8, Math.round(Math.max(region.width, region.height) / 24)); sample.width = Math.max(1, Math.round(region.width / block)); sample.height = Math.max(1, Math.round(region.height / block)); const small = sample.getContext("2d"); if (!small) return; small.drawImage(canvas, region.x, region.y, region.width, region.height, 0, 0, sample.width, sample.height); ctx.imageSmoothingEnabled = false; ctx.drawImage(sample, 0, 0, sample.width, sample.height, region.x, region.y, region.width, region.height); ctx.imageSmoothingEnabled = true; }
function toolHint(tool: Tool): string { if (tool === "crop") return "Drag around the area to keep. Exports use the newest crop; undo restores the full page."; if (tool === "text") return "Click anywhere, type your note, then press Return."; if (tool === "blur") return "Drag over passwords, account details, or anything that should be unreadable."; return "Drag directly on the full-resolution page. You can undo every edit."; }
function captureName(value: string): string { const source = (() => { try { return new URL(value).hostname; } catch { return value; } })(); const clean = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "capture"; return `${clean}-full-page`; }
function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> { return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode the capture.")), type, quality)); }
function download(blob: Blob, filename: string) { const href = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = href; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000); }

async function canvasPdf(canvas: HTMLCanvasElement, size: "continuous" | "a4" | "letter"): Promise<Blob> {
  const dimensions = size === "a4" ? { width: 595.28, height: 841.89 } : size === "letter" ? { width: 612, height: 792 } : null;
  const pages: PdfPage[] = [];
  if (!dimensions) { const pageWidth = Math.min(1440, canvas.width * 0.75); const pageHeight = Math.min(14400, pageWidth * (canvas.height / canvas.width)); pages.push({ jpeg: dataBytes(canvas.toDataURL("image/jpeg", 0.92)), width: canvas.width, height: canvas.height, pageWidth: pageHeight === 14400 ? 14400 * (canvas.width / canvas.height) : pageWidth, pageHeight }); }
  else { const pixelsPerPage = Math.max(1, Math.floor(canvas.width * (dimensions.height / dimensions.width))); for (let y = 0; y < canvas.height; y += pixelsPerPage) { const height = Math.min(pixelsPerPage, canvas.height - y); const page = document.createElement("canvas"); page.width = canvas.width; page.height = height; const ctx = page.getContext("2d"); if (!ctx) throw new Error("Canvas export is unavailable."); ctx.fillStyle = "white"; ctx.fillRect(0, 0, page.width, page.height); ctx.drawImage(canvas, 0, y, canvas.width, height, 0, 0, canvas.width, height); pages.push({ jpeg: dataBytes(page.toDataURL("image/jpeg", 0.92)), width: page.width, height: page.height, pageWidth: dimensions.width, pageHeight: dimensions.height }); } }
  return new Blob([buildPdf(pages) as BlobPart], { type: "application/pdf" });
}
type PdfPage = { jpeg: Uint8Array; width: number; height: number; pageWidth: number; pageHeight: number };
function dataBytes(url: string): Uint8Array { const raw = atob(url.split(",")[1] ?? ""); return Uint8Array.from(raw, (character) => character.charCodeAt(0)); }
function buildPdf(pages: PdfPage[]): Uint8Array {
  const encode = (value: string) => new TextEncoder().encode(value); const join = (chunks: Uint8Array[]) => { const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result; };
  const objectCount = 2 + pages.length * 3; const objects: Uint8Array[] = new Array(objectCount + 1); objects[1] = encode("<< /Type /Catalog /Pages 2 0 R >>"); const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" "); objects[2] = encode(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((page, index) => { const pageId = 3 + index * 3, contentId = pageId + 1, imageId = pageId + 2; const drawHeight = page.pageWidth * (page.height / page.width); const y = page.pageHeight - drawHeight; objects[pageId] = encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.pageWidth.toFixed(2)} ${page.pageHeight.toFixed(2)}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`); const content = encode(`q ${page.pageWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} 0 ${y.toFixed(2)} cm /Im0 Do Q`); objects[contentId] = join([encode(`<< /Length ${content.length} >>\nstream\n`), content, encode("\nendstream")]); objects[imageId] = join([encode(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`), page.jpeg, encode("\nendstream")]); });
  const chunks = [encode("%PDF-1.4\n%Dive Capture\n")]; const offsets = new Array<number>(objectCount + 1).fill(0); let cursor = chunks[0]?.length ?? 0; for (let id = 1; id <= objectCount; id += 1) { const object = join([encode(`${id} 0 obj\n`), objects[id] ?? new Uint8Array(), encode("\nendobj\n")]); offsets[id] = cursor; cursor += object.length; chunks.push(object); } const xref = cursor; chunks.push(encode(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)); return join(chunks);
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
