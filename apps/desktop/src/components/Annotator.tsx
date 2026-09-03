import { ArrowUpRight, Check, EyeOff, Square, Type, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { Icon, IconButton } from "./Icon";

type Tool = "rect" | "arrow" | "text" | "blur";
interface Shape {
  tool: Tool;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  text?: string;
}
const COLORS = ["#ef4444", "#f59e0b", "#3b82f6", "#22c55e", "#ffffff"] as const;
const TOOLS: { id: Tool; icon: typeof Square; label: string }[] = [
  { id: "rect", icon: Square, label: "Rectangle" },
  { id: "arrow", icon: ArrowUpRight, label: "Arrow" },
  { id: "text", icon: Type, label: "Text" },
  { id: "blur", icon: EyeOff, label: "Blur" },
];

/** Mark up a capture: boxes, arrows, labels and blurred regions, then copy + save. */
export function Annotator({ path }: { path: string }) {
  const close = useBrowser((s) => s.setAnnotating);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [tool, setTool] = useState<Tool>("rect");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void ipc.captureRead(path).then((b64) => {
      const img = new Image();
      img.onload = () => alive && setImage(img);
      img.src = `data:image/png;base64,${b64}`;
    });
    return () => {
      alive = false;
    };
  }, [path]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(image, 0, 0);
    for (const s of draft ? [...shapes, draft] : shapes) drawShape(ctx, image, s);
  }, [image, shapes, draft]);
  useEffect(paint, [paint]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (textAt) return;
      if (e.key === "Escape") close(null);
      if ((e.metaKey || e.ctrlKey) && e.key === "z") setShapes((s) => s.slice(0, -1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, textAt]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const scale = e.currentTarget.width / r.width;
    return { x: (e.clientX - r.left) * scale, y: (e.clientY - r.top) * scale };
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = point(e);
    if (tool === "text") {
      setTextAt(p);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft({ tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color });
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draft) return;
    const p = point(e);
    setDraft({ ...draft, x2: p.x, y2: p.y });
  };
  const onUp = () => {
    if (draft && (Math.abs(draft.x2 - draft.x1) > 3 || Math.abs(draft.y2 - draft.y1) > 3)) setShapes((s) => [...s, draft]);
    setDraft(null);
  };
  const commitText = (text: string) => {
    if (textAt && text.trim()) setShapes((s) => [...s, { tool: "text", x1: textAt.x, y1: textAt.y, x2: textAt.x, y2: textAt.y, color, text: text.trim() }]);
    setTextAt(null);
  };
  const done = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    try {
      const saved = await ipc.captureSave(canvas.toDataURL("image/png").split(",")[1] ?? "");
      useBrowser.setState({ notice: `Copied to clipboard · saved ${saved.split("/").pop() ?? saved}` });
      setTimeout(() => useBrowser.setState({ notice: null }), 4000);
      close(null);
    } catch (e) {
      useBrowser.setState({ error: String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-[2px]">
      <div role="toolbar" aria-label="Annotate" className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-3">
        {TOOLS.map((t) => (
          <IconButton key={t.id} icon={t.icon} label={t.label} active={tool === t.id} onClick={() => setTool(t.id)} />
        ))}
        <span className="mx-2 h-4 w-px bg-line" />
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Color ${c}`}
            aria-pressed={color === c}
            onClick={() => setColor(c)}
            className={`h-4 w-4 rounded-full border ${color === c ? "border-ink ring-2 ring-ink/30" : "border-line-2"}`}
            style={{ background: c }}
          />
        ))}
        <span className="mx-2 h-4 w-px bg-line" />
        <IconButton icon={Undo2} label="Undo" disabled={shapes.length === 0} onClick={() => setShapes((s) => s.slice(0, -1))} />
        <span className="flex-1" />
        <span className="mr-2 text-[11px] text-ink-3">Drag to draw · Esc to close</span>
        <button type="button" onClick={() => close(null)} className="h-7 rounded-full border border-line px-3 text-xs text-ink-2 hover:bg-surface-2">
          Skip
        </button>
        <button
          type="button"
          disabled={!image || saving}
          onClick={() => void done()}
          className="ml-1 flex h-7 items-center gap-1 rounded-full bg-accent px-3 text-xs font-medium text-accent-ink hover:brightness-95 disabled:opacity-50"
        >
          <Icon icon={Check} size={13} /> Copy &amp; save
        </button>
        <IconButton icon={X} label="Close annotator" onClick={() => close(null)} />
      </div>
      <div className="relative flex-1 overflow-auto p-6">
        {image && (
          <div className="relative mx-auto w-fit">
            <canvas
              ref={canvasRef}
              width={image.naturalWidth}
              height={image.naturalHeight}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              className="block max-w-full cursor-crosshair rounded-md shadow-2xl"
              style={{ width: Math.min(image.naturalWidth, 1400) }}
            />
            {textAt && (
              <input
                autoFocus
                aria-label="Annotation text"
                className="absolute rounded border border-line-2 bg-surface px-1.5 py-0.5 text-sm text-ink outline-none"
                style={{
                  left: (textAt.x / image.naturalWidth) * 100 + "%",
                  top: (textAt.y / image.naturalHeight) * 100 + "%",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitText(e.currentTarget.value);
                  if (e.key === "Escape") setTextAt(null);
                }}
                onBlur={(e) => commitText(e.currentTarget.value)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function drawShape(ctx: CanvasRenderingContext2D, image: HTMLImageElement, s: Shape) {
  const w = s.x2 - s.x1;
  const h = s.y2 - s.y1;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = Math.max(3, image.naturalWidth / 400);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  switch (s.tool) {
    case "rect":
      ctx.strokeRect(s.x1, s.y1, w, h);
      break;
    case "arrow": {
      const head = ctx.lineWidth * 4;
      const angle = Math.atan2(h, w);
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 6), s.y2 - head * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 6), s.y2 - head * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "text": {
      const size = Math.max(16, image.naturalWidth / 60);
      ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
      ctx.lineWidth = size / 5;
      ctx.strokeStyle = "rgba(0,0,0,0.75)";
      ctx.strokeText(s.text ?? "", s.x1, s.y1 + size);
      ctx.fillText(s.text ?? "", s.x1, s.y1 + size);
      break;
    }
    case "blur": {
      // Pixelate: downscale the region and draw it back without smoothing.
      const x = Math.min(s.x1, s.x2);
      const y = Math.min(s.y1, s.y2);
      const rw = Math.abs(w);
      const rh = Math.abs(h);
      if (rw < 1 || rh < 1) break;
      const block = Math.max(8, Math.round(Math.max(rw, rh) / 20));
      const tmp = document.createElement("canvas");
      tmp.width = Math.max(1, Math.round(rw / block));
      tmp.height = Math.max(1, Math.round(rh / block));
      const tctx = tmp.getContext("2d");
      if (!tctx) break;
      tctx.drawImage(image, x, y, rw, rh, 0, 0, tmp.width, tmp.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, rw, rh);
      break;
    }
  }
  ctx.restore();
}
