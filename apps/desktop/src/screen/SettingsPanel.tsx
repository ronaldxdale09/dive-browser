import { ArrowLeft, Crop, Download, HelpCircle, LayoutTemplate, MousePointer2, Palette, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import { Tooltip } from "../components/Tooltip";
import { ASPECT_RATIOS, SOLID_COLORS, WALLPAPERS } from "./model";
import type { AnnotationRegion, Project, TextAnimation, ZoomRegion } from "./model";
import { useEditor } from "./store";

/**
 * The right-hand panel: a rail of sections beside their controls. What is
 * selected on the timeline takes the panel over (a zoom, a cut, a speed
 * change, a note) until it is deselected.
 */
type SectionId = "background" | "effects" | "layout" | "cursor";

const SECTIONS: { id: SectionId; icon: LucideIcon; label: string }[] = [
  { id: "background", icon: Palette, label: "Background" },
  { id: "effects", icon: SlidersHorizontal, label: "Video Effects" },
  { id: "layout", icon: LayoutTemplate, label: "Layout" },
  { id: "cursor", icon: MousePointer2, label: "Cursor" },
];

export function SettingsPanel({ onExport }: { onExport: () => void }) {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const [section, setSection] = useState<SectionId>("effects");
  if (!project) return null;
  const e = project.editor;
  const zoom = selection?.kind === "zoom" ? e.zooms.find((z) => z.id === selection.id) : undefined;
  const speed = selection?.kind === "speed" ? e.speeds.find((s) => s.id === selection.id) : undefined;
  const trim = selection?.kind === "trim" ? e.trims.find((t) => t.id === selection.id) : undefined;
  const note = selection?.kind === "annotation" ? e.annotations.find((a) => a.id === selection.id) : undefined;
  const contextual = zoom ?? speed ?? trim ?? note;
  const title = zoom ? "Zoom" : speed ? "Speed" : trim ? "Cut" : note ? "Note" : (SECTIONS.find((s) => s.id === section)?.label ?? "");

  return (
    <aside className="flex h-full w-[400px] shrink-0 rounded-2xl border border-line bg-surface">
      <nav aria-label="Sections" className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line py-3">
        {SECTIONS.map((s) => (
          <Tooltip key={s.id} label={s.label} align="start">
            <button
              type="button"
              aria-label={s.label}
              aria-pressed={!contextual && section === s.id}
              onClick={() => {
                select(null);
                setSection(s.id);
              }}
              className={`grid size-9 place-items-center rounded-xl transition-colors ${!contextual && section === s.id ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40" : "text-ink-3 hover:bg-surface-2 hover:text-ink"}`}
            >
              <Icon icon={s.icon} size={16} />
            </button>
          </Tooltip>
        ))}
        <span className="flex-1" />
        <Tooltip label="Export" align="start">
          <button type="button" aria-label="Export" onClick={onExport} className="grid size-9 place-items-center rounded-xl text-ink-3 hover:bg-surface-2 hover:text-ink">
            <Icon icon={Download} size={16} />
          </button>
        </Tooltip>
      </nav>
      <div className="scroll-hidden flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="flex h-14 shrink-0 items-center gap-2 px-5">
          {contextual && (
            <button type="button" aria-label="Back to the video settings" onClick={() => select(null)} className="grid size-7 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink">
              <Icon icon={ArrowLeft} size={14} />
            </button>
          )}
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <span className="flex-1" />
          <span className="text-ink-3" title="Drag items on the timeline; press Z, T, A, S or B to add">
            <Icon icon={HelpCircle} size={15} />
          </span>
        </header>
        <div className="flex flex-col gap-4 px-5 pb-5 text-xs">
          {zoom ? <ZoomSettings zoom={zoom} project={project} /> : speed ? <SpeedSettings id={speed.id} speed={speed.speed} /> : trim ? <TrimSettings /> : note ? <NoteSettings note={note} /> : section === "background" ? <BackgroundSettings project={project} /> : section === "effects" ? <EffectsSettings project={project} /> : section === "layout" ? <LayoutSettings project={project} /> : <CursorSettings project={project} />}
        </div>
      </div>
    </aside>
  );
}

/* ---------------------------------------------------------------- pieces */

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-surface-2/60 p-3.5 ${className}`}>{children}</div>;
}

function Switch({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-[13px] text-ink">
      <span className="flex-1">
        {label}
        {hint && <span className="ml-1 text-ink-3" title={hint}>ⓘ</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-emerald-500" : "bg-surface-3"}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
    </label>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  const checkpoint = useEditor((s) => s.checkpoint);
  return (
    <Card>
      <label className="flex flex-col gap-2">
        <span className="flex text-[13px] text-ink">
          {label}
          <span className="ml-auto font-mono text-[11px] text-ink-3">{format ? format(value) : value}</span>
        </span>
        <input type="range" min={min} max={max} step={step} value={value} onPointerDown={checkpoint} onChange={(ev) => onChange(Number(ev.target.value))} className="h-1 accent-emerald-400" />
      </label>
    </Card>
  );
}

function Choice<T extends string | number>({ value, options, onChange, cols = 3 }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; cols?: number }) {
  return (
    <div role="radiogroup" className="grid gap-1 rounded-lg bg-surface-2 p-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)} className={`h-7 rounded-md text-[11px] transition-colors ${o.value === value ? "bg-surface text-ink shadow-sm ring-1 ring-line-2" : "text-ink-2 hover:text-ink"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="text-[13px] text-ink">{children}</span>;
}

function DeleteButton() {
  const del = useEditor((s) => s.deleteSelected);
  return (
    <button type="button" onClick={del} className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-line text-ink-2 hover:border-red-500/50 hover:text-red-300">
      <Icon icon={Trash2} size={13} /> Delete
    </button>
  );
}

/* ---------------------------------------------------------------- sections */

function BackgroundSettings({ project }: { project: Project }) {
  const update = useEditor((s) => s.update);
  const e = project.editor;
  const set = (p: Partial<Project["editor"]>, history = true) => update((ed) => ({ ...ed, ...p }), history);
  return (
    <>
      <Card>
        <Label>Wallpaper</Label>
        <div className="mt-2 grid grid-cols-6 gap-1.5">
          {WALLPAPERS.map((w) => (
            <button key={w.id} type="button" aria-label={w.name} aria-pressed={e.wallpaper === w.id} title={w.name} onClick={() => set({ wallpaper: w.id })} className={`aspect-square rounded-lg ring-offset-2 ring-offset-surface ${e.wallpaper === w.id ? "ring-2 ring-emerald-400" : ""}`} style={{ background: w.css }} />
          ))}
        </div>
      </Card>
      <Card>
        <Label>Colour</Label>
        <div className="mt-2 grid grid-cols-6 gap-1.5">
          {SOLID_COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} aria-pressed={e.wallpaper === c} onClick={() => set({ wallpaper: c })} className={`aspect-square rounded-lg border border-line ring-offset-2 ring-offset-surface ${e.wallpaper === c ? "ring-2 ring-emerald-400" : ""}`} style={{ background: c }} />
          ))}
          <input type="color" aria-label="Custom colour" value={/^#[0-9a-f]{6}$/i.test(e.wallpaper) ? e.wallpaper : "#222222"} onChange={(ev) => set({ wallpaper: ev.target.value }, false)} className="aspect-square w-full rounded-lg border border-line bg-surface-2" />
        </div>
      </Card>
      <Card>
        <Label>Picture</Label>
        <label className="mt-2 flex h-9 cursor-pointer items-center justify-center rounded-lg border border-dashed border-line-2 text-ink-2 hover:text-ink">
          Upload a picture
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(ev) => {
              const f = ev.target.files?.[0];
              if (!f) return;
              const r = new FileReader();
              r.onload = () => set({ wallpaper: String(r.result) });
              r.readAsDataURL(f);
            }}
          />
        </label>
        <Switch label="Blur the picture" checked={e.blurBackground} onChange={(v) => set({ blurBackground: v })} />
      </Card>
    </>
  );
}

function EffectsSettings({ project }: { project: Project }) {
  const update = useEditor((s) => s.update);
  const e = project.editor;
  const set = (p: Partial<Project["editor"]>, history = true) => update((ed) => ({ ...ed, ...p }), history);
  return (
    <div className="grid grid-cols-2 gap-3">
      <Slider label="Padding" value={e.padding} min={0} max={100} step={1} onChange={(v) => set({ padding: v }, false)} />
      <Slider label="Roundness" value={e.roundness} min={0} max={64} step={0.5} onChange={(v) => set({ roundness: v }, false)} />
      <Slider label="Shadow" value={e.shadow} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ shadow: v }, false)} />
      <Card className="flex items-center">
        <Switch label="Blur BG" checked={e.blurBackground} onChange={(v) => set({ blurBackground: v })} hint="Softens an uploaded picture behind the video" />
      </Card>
    </div>
  );
}

function LayoutSettings({ project }: { project: Project }) {
  const update = useEditor((s) => s.update);
  const e = project.editor;
  const set = (p: Partial<Project["editor"]>, history = true) => update((ed) => ({ ...ed, ...p }), history);
  return (
    <>
      <Card>
        <Label>Aspect ratio</Label>
        <div className="mt-2">
          <Choice value={e.aspectRatio} options={ASPECT_RATIOS.map((r) => ({ value: r, label: r }))} onChange={(aspectRatio) => set({ aspectRatio })} cols={4} />
        </div>
      </Card>
      <Card>
        <span className="flex items-center gap-1.5 text-[13px] text-ink">
          <Icon icon={Crop} size={13} /> Crop
        </span>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
          <Small label="Left" value={Math.round(e.crop.x * 100)} min={0} max={90} onChange={(v) => set({ crop: { ...e.crop, x: v / 100, width: Math.min(e.crop.width, 1 - v / 100) } }, false)} />
          <Small label="Top" value={Math.round(e.crop.y * 100)} min={0} max={90} onChange={(v) => set({ crop: { ...e.crop, y: v / 100, height: Math.min(e.crop.height, 1 - v / 100) } }, false)} />
          <Small label="Width" value={Math.round(e.crop.width * 100)} min={10} max={100} onChange={(v) => set({ crop: { ...e.crop, width: Math.min(v / 100, 1 - e.crop.x) } }, false)} />
          <Small label="Height" value={Math.round(e.crop.height * 100)} min={10} max={100} onChange={(v) => set({ crop: { ...e.crop, height: Math.min(v / 100, 1 - e.crop.y) } }, false)} />
        </div>
      </Card>
    </>
  );
}

function Small({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const checkpoint = useEditor((s) => s.checkpoint);
  return (
    <label className="flex flex-col gap-1 text-ink-2">
      <span className="flex">
        {label}
        <span className="ml-auto font-mono text-ink-3">{value}%</span>
      </span>
      <input type="range" min={min} max={max} step={1} value={value} onPointerDown={checkpoint} onChange={(ev) => onChange(Number(ev.target.value))} className="h-1 accent-emerald-400" />
    </label>
  );
}

function CursorSettings({ project }: { project: Project }) {
  const update = useEditor((s) => s.update);
  const hasPointer = useEditor((s) => s.cursorRaw.length > 0);
  const e = project.editor;
  const cursor = (p: Partial<Project["editor"]["cursor"]>, history = true) => update((ed) => ({ ...ed, cursor: { ...ed.cursor, ...p } }), history);
  return (
    <>
      {!hasPointer && <p className="rounded-lg border border-line bg-surface-2/60 p-3 text-ink-3">This recording has no pointer track (window captures carry the pointer in the picture), so these settings do not apply to it.</p>}
      {/* Controls that cannot take effect read as off, not merely explained. */}
      <div className={hasPointer ? "contents" : "pointer-events-none opacity-40"} aria-disabled={!hasPointer || undefined}>
      <Card>
        <Switch label="Show Cursor" checked={e.cursor.show} onChange={(v) => cursor({ show: v })} />
        <Switch label="Clip to Canvas" checked={e.cursor.clipToCanvas} onChange={(v) => cursor({ clipToCanvas: v })} hint="Hide the pointer when it leaves the video" />
        <Switch label="Ring on clicks" checked={e.cursor.clickRing} onChange={(v) => cursor({ clickRing: v })} />
      </Card>
      <div className="grid grid-cols-2 gap-3">
        <Slider label="Size" value={e.cursor.size} min={0.5} max={10} step={0.1} format={(v) => v.toFixed(1)} onChange={(v) => cursor({ size: v }, false)} />
        <Slider label="Smoothing" value={e.cursor.smoothing} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => cursor({ smoothing: v }, false)} />
        <Slider label="Click Bounce" value={e.cursor.clickBounce} min={0} max={5} step={0.1} format={(v) => v.toFixed(1)} onChange={(v) => cursor({ clickBounce: v }, false)} />
      </div>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- contextual */

function ZoomSettings({ zoom, project }: { zoom: ZoomRegion; project: Project }) {
  const update = useEditor((s) => s.update);
  const patch = (p: Omit<Partial<ZoomRegion>, "customScale"> & { customScale?: number | undefined }, history = true) =>
    update(
      (e) => ({
        ...e,
        zooms: e.zooms.map((z) => {
          if (z.id !== zoom.id) return z;
          const { customScale, ...rest } = p;
          const next: ZoomRegion = { ...z, ...rest, source: "manual" };
          if ("customScale" in p) {
            if (customScale === undefined) delete next.customScale;
            else next.customScale = customScale;
          }
          return next;
        }),
      }),
      history,
    );
  const followAll = project.editor.autoFocusAll;
  return (
    <>
      <Card>
        <Label>Zoom level</Label>
        <div className="mt-2">
          <Choice value={zoom.customScale ? 0 : zoom.depth} options={[1, 2, 3, 4, 5, 6].map((d) => ({ value: d, label: String(d) }))} onChange={(depth) => patch({ depth, customScale: undefined })} cols={6} />
        </div>
      </Card>
      <Slider label="Custom zoom" value={zoom.customScale ?? 1} min={1} max={5} step={0.01} format={(v) => (v > 1 ? `${v.toFixed(2)}×` : "off")} onChange={(v) => patch({ customScale: v <= 1 ? undefined : v }, false)} />
      <Card>
        <Label>Focus</Label>
        <div className="mt-2">
          <Choice value={followAll ? "auto" : zoom.focusMode} options={[{ value: "manual", label: "Manual" }, { value: "auto", label: "Follow pointer" }]} onChange={(focusMode) => !followAll && patch({ focusMode })} cols={2} />
        </div>
        {followAll ? (
          <p className="mt-2 text-ink-3">Every zoom follows the pointer while the crosshair in the timeline toolbar is on.</p>
        ) : (
          zoom.focusMode === "manual" && (
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
              <Small label="X" value={Math.round(zoom.focus.cx * 100)} min={0} max={100} onChange={(v) => patch({ focus: { ...zoom.focus, cx: v / 100 } }, false)} />
              <Small label="Y" value={Math.round(zoom.focus.cy * 100)} min={0} max={100} onChange={(v) => patch({ focus: { ...zoom.focus, cy: v / 100 } }, false)} />
              <p className="col-span-2 text-ink-3">Or drag the green dot on the preview.</p>
            </div>
          )
        )}
      </Card>
      <DeleteButton />
    </>
  );
}

function SpeedSettings({ id, speed }: { id: string; speed: number }) {
  const update = useEditor((s) => s.update);
  const set = (v: number, history = true) => update((e) => ({ ...e, speeds: e.speeds.map((s) => (s.id === id ? { ...s, speed: Math.min(16, Math.max(0.1, v)) } : s)) }), history);
  return (
    <>
      <Card>
        <Label>Speed</Label>
        <div className="mt-2">
          <Choice value={speed} options={[0.25, 0.5, 1, 1.5, 2, 3, 5].map((v) => ({ value: v, label: `${v}×` }))} onChange={(v) => set(v)} cols={4} />
        </div>
      </Card>
      <Slider label="Custom" value={speed} min={0.1} max={16} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(v) => set(v, false)} />
      <DeleteButton />
    </>
  );
}

function TrimSettings() {
  return (
    <>
      <Card>
        <p className="text-ink-2">This stretch is left out of the finished video. Drag its edges on the timeline to change what is cut.</p>
      </Card>
      <DeleteButton />
    </>
  );
}

const ANIMATIONS: { value: TextAnimation; label: string }[] = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "rise", label: "Rise" },
  { value: "pop", label: "Pop" },
  { value: "slide-left", label: "Slide" },
  { value: "typewriter", label: "Type" },
  { value: "pulse", label: "Pulse" },
];

function NoteSettings({ note }: { note: AnnotationRegion }) {
  const update = useEditor((s) => s.update);
  const patch = (p: Partial<AnnotationRegion>, history = true) => update((e) => ({ ...e, annotations: e.annotations.map((a) => (a.id === note.id ? { ...a, ...p } : a)) }), history);
  const style = (p: Partial<AnnotationRegion["style"]>, history = true) => patch({ style: { ...note.style, ...p } }, history);
  return (
    <>
      {note.type === "text" && (
        <>
          <Card>
            <Label>Text</Label>
            <textarea value={note.text ?? ""} onChange={(ev) => patch({ text: ev.target.value }, false)} onBlur={() => useEditor.getState().checkpoint()} rows={3} className="mt-2 w-full rounded-lg border border-line bg-surface p-2 text-xs text-ink outline-none focus:border-line-2" />
            <div className="mt-2 flex gap-1">
              {(["bold", "italic", "underline"] as const).map((k) => (
                <button key={k} type="button" aria-pressed={note.style[k]} onClick={() => style({ [k]: !note.style[k] })} className="h-7 flex-1 rounded-md bg-surface text-[11px] text-ink-2 aria-pressed:bg-surface-3 aria-pressed:text-ink">
                  {k[0]!.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="mt-2">
              <Choice value={note.style.align} options={[{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }]} onChange={(align) => style({ align })} />
            </div>
          </Card>
          <Card>
            <Label>Colours</Label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-ink-2">
                Text
                <input type="color" value={note.style.color} onChange={(ev) => style({ color: ev.target.value }, false)} className="h-8 w-full rounded border border-line bg-surface" />
              </label>
              <label className="flex flex-col gap-1 text-ink-2">
                Background
                <input type="color" value={note.style.background === "transparent" ? "#000000" : note.style.background} onChange={(ev) => style({ background: ev.target.value }, false)} className="h-8 w-full rounded border border-line bg-surface" />
              </label>
            </div>
            <Switch label="No background" checked={note.style.background === "transparent"} onChange={(v) => style({ background: v ? "transparent" : "#000000cc" })} />
          </Card>
          <Slider label="Size" value={note.style.fontSize} min={12} max={128} step={1} onChange={(v) => style({ fontSize: v }, false)} />
          <Card>
            <Label>Animation</Label>
            <div className="mt-2">
              <Choice value={note.style.animation} options={ANIMATIONS} onChange={(animation) => style({ animation })} cols={4} />
            </div>
          </Card>
        </>
      )}
      {note.type === "arrow" && (
        <>
          <Card>
            <Label>Direction</Label>
            <div className="mt-2">
              <Choice value={note.style.direction} options={(["up-left", "up", "up-right", "left", "right", "down-left", "down", "down-right"] as const).map((d) => ({ value: d, label: arrowGlyph(d) }))} onChange={(direction) => style({ direction })} cols={4} />
            </div>
            <label className="mt-3 flex flex-col gap-1 text-ink-2">
              Colour
              <input type="color" value={note.style.color} onChange={(ev) => style({ color: ev.target.value }, false)} className="h-8 w-full rounded border border-line bg-surface" />
            </label>
          </Card>
          <Slider label="Thickness" value={note.style.strokeWidth} min={1} max={6} step={1} onChange={(v) => style({ strokeWidth: v }, false)} />
        </>
      )}
      {note.type === "image" && (
        <Card>
          <Label>Picture</Label>
          <input
            type="file"
            accept="image/*"
            onChange={(ev) => {
              const f = ev.target.files?.[0];
              if (!f) return;
              const r = new FileReader();
              r.onload = () => patch({ image: String(r.result) });
              r.readAsDataURL(f);
            }}
            className="mt-2 text-ink-2"
          />
        </Card>
      )}
      {note.type === "blur" && (
        <>
          <Card>
            <Label>Shape</Label>
            <div className="mt-2">
              <Choice value={note.style.shape} options={[{ value: "rectangle", label: "Rectangle" }, { value: "oval", label: "Oval" }]} onChange={(shape) => style({ shape })} cols={2} />
            </div>
          </Card>
          <Slider label="Block size" value={note.style.blockSize} min={4} max={48} step={1} onChange={(v) => style({ blockSize: v }, false)} />
        </>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Slider label="Width" value={note.size.width} min={1} max={200} step={1} format={(v) => `${v}%`} onChange={(v) => patch({ size: { ...note.size, width: v } }, false)} />
        <Slider label="Height" value={note.size.height} min={1} max={200} step={1} format={(v) => `${v}%`} onChange={(v) => patch({ size: { ...note.size, height: v } }, false)} />
      </div>
      <p className="text-ink-3">Drag on the preview to move it.</p>
      <DeleteButton />
    </>
  );
}

function arrowGlyph(d: string): string {
  return ({ up: "↑", down: "↓", left: "←", right: "→", "up-left": "↖", "up-right": "↗", "down-left": "↙", "down-right": "↘" } as Record<string, string>)[d] ?? d;
}
