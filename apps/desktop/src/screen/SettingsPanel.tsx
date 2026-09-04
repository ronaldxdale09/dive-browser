import { Trash2, Wand2 } from "lucide-react";
import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import { ASPECT_RATIOS, SOLID_COLORS, WALLPAPERS } from "./model";
import type { AnnotationRegion, Project, TextAnimation, ZoomRegion } from "./model";
import { useEditor } from "./store";

/**
 * The sidebar: what is selected decides what it shows. A zoom, a cut, a
 * speed change or a note get their own controls; with nothing selected it
 * is the look of the whole video.
 */
export function SettingsPanel() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  if (!project) return null;
  const e = project.editor;
  const zoom = selection?.kind === "zoom" ? e.zooms.find((z) => z.id === selection.id) : undefined;
  const speed = selection?.kind === "speed" ? e.speeds.find((s) => s.id === selection.id) : undefined;
  const trim = selection?.kind === "trim" ? e.trims.find((t) => t.id === selection.id) : undefined;
  const note = selection?.kind === "annotation" ? e.annotations.find((a) => a.id === selection.id) : undefined;
  return (
    <aside className="scroll-hidden flex h-full w-[272px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-line bg-surface p-4 text-xs">
      {zoom ? <ZoomSettings zoom={zoom} project={project} /> : speed ? <SpeedSettings id={speed.id} speed={speed.speed} /> : trim ? <TrimSettings /> : note ? <NoteSettings note={note} /> : <LookSettings project={project} />}
    </aside>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center">
        <h3 className="text-[10px] font-medium tracking-[0.08em] text-ink-3 uppercase">{title}</h3>
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  const checkpoint = useEditor((s) => s.checkpoint);
  return (
    <label className="flex flex-col gap-1">
      <span className="flex text-ink-2">
        {label}
        <span className="ml-auto font-mono text-ink-3">{format ? format(value) : value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onPointerDown={checkpoint} onChange={(ev) => onChange(Number(ev.target.value))} className="accent-highlight" />
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-ink-2">
      <input type="checkbox" checked={checked} onChange={(ev) => onChange(ev.target.checked)} className="accent-highlight" />
      {label}
    </label>
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

function DeleteButton() {
  const del = useEditor((s) => s.deleteSelected);
  return (
    <button type="button" onClick={del} className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-line text-ink-2 hover:border-danger/40 hover:text-danger">
      <Icon icon={Trash2} size={13} /> Delete
    </button>
  );
}

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
      <Section title="Zoom level">
        <Choice value={zoom.customScale ? 0 : zoom.depth} options={[1, 2, 3, 4, 5, 6].map((d) => ({ value: d, label: String(d) }))} onChange={(depth) => patch({ depth, customScale: undefined })} cols={6} />
        <Slider label="Custom zoom" value={zoom.customScale ?? 0} min={1} max={5} step={0.01} format={(v) => (v ? `${v.toFixed(2)}×` : "off")} onChange={(v) => patch({ customScale: v <= 1 ? undefined : v }, false)} />
      </Section>
      <Section title="Focus">
        <Choice value={followAll ? "auto" : zoom.focusMode} options={[{ value: "manual", label: "Manual" }, { value: "auto", label: "Follow pointer" }]} onChange={(focusMode) => !followAll && patch({ focusMode })} cols={2} />
        {followAll && <p className="text-ink-3">Every zoom follows the pointer while “All zooms follow the pointer” is on.</p>}
        {!followAll && zoom.focusMode === "manual" && (
          <>
            <p className="text-ink-3">Drag the green dot on the preview, or set it here.</p>
            <Slider label="X" value={Math.round(zoom.focus.cx * 1000) / 10} min={0} max={100} step={0.1} format={(v) => `${v}%`} onChange={(v) => patch({ focus: { ...zoom.focus, cx: v / 100 } }, false)} />
            <Slider label="Y" value={Math.round(zoom.focus.cy * 1000) / 10} min={0} max={100} step={0.1} format={(v) => `${v}%`} onChange={(v) => patch({ focus: { ...zoom.focus, cy: v / 100 } }, false)} />
          </>
        )}
      </Section>
      <DeleteButton />
    </>
  );
}

function SpeedSettings({ id, speed }: { id: string; speed: number }) {
  const update = useEditor((s) => s.update);
  const set = (v: number, history = true) => update((e) => ({ ...e, speeds: e.speeds.map((s) => (s.id === id ? { ...s, speed: Math.min(16, Math.max(0.1, v)) } : s)) }), history);
  return (
    <>
      <Section title="Speed">
        <Choice value={speed} options={[0.25, 0.5, 1, 1.5, 2, 3, 5].map((v) => ({ value: v, label: `${v}×` }))} onChange={(v) => set(v)} cols={4} />
        <Slider label="Custom" value={speed} min={0.1} max={16} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(v) => set(v, false)} />
      </Section>
      <DeleteButton />
    </>
  );
}

function TrimSettings() {
  return (
    <>
      <Section title="Cut">
        <p className="text-ink-2">This stretch is left out of the finished video. Drag its edges on the timeline to change what is cut.</p>
      </Section>
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
        <Section title="Text">
          <textarea value={note.text ?? ""} onChange={(ev) => patch({ text: ev.target.value }, false)} onBlur={() => useEditor.getState().checkpoint()} rows={3} className="rounded-lg border border-line bg-surface-2 p-2 text-xs text-ink outline-none focus:border-line-2" />
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-ink-2">
              Colour
              <input type="color" value={note.style.color} onChange={(ev) => style({ color: ev.target.value }, false)} className="h-8 w-full rounded border border-line bg-surface-2" />
            </label>
            <label className="flex flex-col gap-1 text-ink-2">
              Background
              <input type="color" value={note.style.background === "transparent" ? "#000000" : note.style.background} onChange={(ev) => style({ background: ev.target.value }, false)} className="h-8 w-full rounded border border-line bg-surface-2" />
            </label>
          </div>
          <Toggle label="No background" checked={note.style.background === "transparent"} onChange={(v) => style({ background: v ? "transparent" : "#000000cc" })} />
          <Slider label="Size" value={note.style.fontSize} min={12} max={128} step={1} onChange={(v) => style({ fontSize: v }, false)} />
          <div className="flex gap-1">
            {(["bold", "italic", "underline"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={note.style[k]} onClick={() => style({ [k]: !note.style[k] })} className="h-7 flex-1 rounded-md bg-surface-2 text-[11px] text-ink-2 aria-pressed:bg-surface-3 aria-pressed:text-ink">
                {k[0]!.toUpperCase()}
              </button>
            ))}
          </div>
          <Choice value={note.style.align} options={[{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }]} onChange={(align) => style({ align })} />
          <Choice value={note.style.animation} options={ANIMATIONS} onChange={(animation) => style({ animation })} cols={4} />
        </Section>
      )}
      {note.type === "arrow" && (
        <Section title="Arrow">
          <Choice value={note.style.direction} options={(["up-left", "up", "up-right", "left", "right", "right", "down-left", "down", "down-right"] as const).filter((d, i, a) => a.indexOf(d) === i).map((d) => ({ value: d, label: arrowGlyph(d) }))} onChange={(direction) => style({ direction })} cols={4} />
          <label className="flex flex-col gap-1 text-ink-2">
            Colour
            <input type="color" value={note.style.color} onChange={(ev) => style({ color: ev.target.value }, false)} className="h-8 w-full rounded border border-line bg-surface-2" />
          </label>
          <Slider label="Thickness" value={note.style.strokeWidth} min={1} max={6} step={1} onChange={(v) => style({ strokeWidth: v }, false)} />
        </Section>
      )}
      {note.type === "image" && (
        <Section title="Picture">
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
            className="text-ink-2"
          />
        </Section>
      )}
      {note.type === "blur" && (
        <Section title="Blur">
          <Choice value={note.style.shape} options={[{ value: "rectangle", label: "Rectangle" }, { value: "oval", label: "Oval" }]} onChange={(shape) => style({ shape })} cols={2} />
          <Slider label="Block size" value={note.style.blockSize} min={4} max={48} step={1} onChange={(v) => style({ blockSize: v }, false)} />
        </Section>
      )}
      <Section title="Place">
        <Slider label="Width" value={note.size.width} min={1} max={200} step={1} format={(v) => `${v}%`} onChange={(v) => patch({ size: { ...note.size, width: v } }, false)} />
        <Slider label="Height" value={note.size.height} min={1} max={200} step={1} format={(v) => `${v}%`} onChange={(v) => patch({ size: { ...note.size, height: v } }, false)} />
        <p className="text-ink-3">Drag on the preview to move it.</p>
      </Section>
      <DeleteButton />
    </>
  );
}

function arrowGlyph(d: string): string {
  return ({ up: "↑", down: "↓", left: "←", right: "→", "up-left": "↖", "up-right": "↗", "down-left": "↙", "down-right": "↘" } as Record<string, string>)[d] ?? d;
}

function LookSettings({ project }: { project: Project }) {
  const update = useEditor((s) => s.update);
  const autoZoom = useEditor((s) => s.autoZoom);
  const cursorRaw = useEditor((s) => s.cursorRaw);
  const e = project.editor;
  const set = (p: Partial<Project["editor"]>, history = true) => update((ed) => ({ ...ed, ...p }), history);
  const cursor = (p: Partial<Project["editor"]["cursor"]>, history = true) => set({ cursor: { ...e.cursor, ...p } }, history);
  const hasPointer = cursorRaw.length > 0;
  return (
    <>
      <Section title="Canvas">
        <Choice value={e.aspectRatio} options={ASPECT_RATIOS.map((r) => ({ value: r, label: r }))} onChange={(aspectRatio) => set({ aspectRatio })} cols={4} />
        <Slider label="Padding" value={e.padding} min={0} max={100} step={1} onChange={(v) => set({ padding: v }, false)} />
        <Slider label="Roundness" value={e.roundness} min={0} max={64} step={0.5} onChange={(v) => set({ roundness: v }, false)} />
        <Slider label="Shadow" value={e.shadow} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ shadow: v }, false)} />
      </Section>
      <Section title="Background">
        <div className="grid grid-cols-6 gap-1.5">
          {WALLPAPERS.map((w) => (
            <button key={w.id} type="button" aria-label={w.name} aria-pressed={e.wallpaper === w.id} title={w.name} onClick={() => set({ wallpaper: w.id })} className={`aspect-square rounded-md ring-offset-1 ring-offset-surface ${e.wallpaper === w.id ? "ring-2 ring-highlight" : ""}`} style={{ background: w.css }} />
          ))}
          {SOLID_COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} aria-pressed={e.wallpaper === c} onClick={() => set({ wallpaper: c })} className={`aspect-square rounded-md border border-line ring-offset-1 ring-offset-surface ${e.wallpaper === c ? "ring-2 ring-highlight" : ""}`} style={{ background: c }} />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input type="color" aria-label="Custom colour" value={/^#[0-9a-f]{6}$/i.test(e.wallpaper) ? e.wallpaper : "#222222"} onChange={(ev) => set({ wallpaper: ev.target.value }, false)} className="h-8 w-10 rounded border border-line bg-surface-2" />
          <label className="flex h-8 flex-1 cursor-pointer items-center justify-center rounded-lg border border-line text-ink-2 hover:text-ink">
            Upload picture
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
        </div>
        <Toggle label="Blur the picture" checked={e.blurBackground} onChange={(v) => set({ blurBackground: v })} />
      </Section>
      <Section
        title="Zoom"
        action={
          <button type="button" onClick={autoZoom} disabled={!hasPointer} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-highlight hover:bg-surface-2 disabled:opacity-40" title="Add zooms where the pointer lingered">
            <Icon icon={Wand2} size={12} /> Suggest
          </button>
        }
      >
        <Toggle label="All zooms follow the pointer" checked={e.autoFocusAll} onChange={(v) => set({ autoFocusAll: v })} />
        {!hasPointer && <p className="text-ink-3">This recording has no pointer track (it was a window capture), so zooms are placed by hand.</p>}
      </Section>
      <Section title="Pointer">
        <Toggle label="Show the pointer" checked={e.cursor.show} onChange={(v) => cursor({ show: v })} />
        <Slider label="Size" value={e.cursor.size} min={0.5} max={10} step={0.1} onChange={(v) => cursor({ size: v }, false)} />
        <Slider label="Smoothing" value={e.cursor.smoothing} min={0} max={1} step={0.01} onChange={(v) => cursor({ smoothing: v }, false)} />
        <Slider label="Click bounce" value={e.cursor.clickBounce} min={0} max={5} step={0.1} onChange={(v) => cursor({ clickBounce: v }, false)} />
        <Toggle label="Ring on clicks" checked={e.cursor.clickRing} onChange={(v) => cursor({ clickRing: v })} />
        <Toggle label="Keep inside the video" checked={e.cursor.clipToCanvas} onChange={(v) => cursor({ clipToCanvas: v })} />
      </Section>
      <Section title="Crop">
        <Slider label="Left" value={Math.round(e.crop.x * 100)} min={0} max={90} step={1} format={(v) => `${v}%`} onChange={(v) => set({ crop: { ...e.crop, x: v / 100, width: Math.min(e.crop.width, 1 - v / 100) } }, false)} />
        <Slider label="Top" value={Math.round(e.crop.y * 100)} min={0} max={90} step={1} format={(v) => `${v}%`} onChange={(v) => set({ crop: { ...e.crop, y: v / 100, height: Math.min(e.crop.height, 1 - v / 100) } }, false)} />
        <Slider label="Width" value={Math.round(e.crop.width * 100)} min={10} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => set({ crop: { ...e.crop, width: Math.min(v / 100, 1 - e.crop.x) } }, false)} />
        <Slider label="Height" value={Math.round(e.crop.height * 100)} min={10} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => set({ crop: { ...e.crop, height: Math.min(v / 100, 1 - e.crop.y) } }, false)} />
      </Section>
    </>
  );
}
