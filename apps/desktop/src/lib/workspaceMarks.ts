/**
 * Dive's own workspace marks: original artwork, quietly animated.
 *
 * DiceBear's sets are either abstract blobs, which say nothing about what a
 * workspace is for, or Bootstrap Icons, which say something but are the same
 * glyphs every other product uses. Neither can move. These are drawn here so
 * a workspace reads as a *place you work* and so the mark can breathe: one
 * slow loop each, four to nine seconds, nothing that flashes or demands the
 * eye in a rail you look at all day.
 *
 * They render inside `<img src="data:image/svg+xml,…">`, where CSS animation
 * declared in the document works and scripts do not — so the motion lives in
 * a `<style>` block. Each carries its own reduced-motion query, because an
 * `<img>` is its own document and never inherits the chrome's.
 *
 * Two tones only: the workspace's colour as ground, and one ink chosen for
 * contrast against it. That keeps a mark legible on every swatch, at 24px in
 * the rail as well as 56px in setup.
 */

/** A mark's drawing, given the ink to paint it in. */
type Draw = (ink: string) => string;

/** Shared for every mark: slow, subtle, and off when motion is unwelcome. */
const MOTION = `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;

const marks: Record<string, Draw> = {
  // A satellite circling a core: a project orbiting the work you do.
  orbit: (ink) => `
    <style>@keyframes spin{to{transform:rotate(360deg)}}.o{animation:spin 9s linear infinite;transform-origin:20px 20px}${MOTION}</style>
    <circle cx="20" cy="20" r="4.5" fill="${ink}"/>
    <g class="o"><ellipse cx="20" cy="20" rx="12" ry="12" stroke="${ink}" stroke-opacity=".35" fill="none" stroke-width="1.6"/><circle cx="32" cy="20" r="2.6" fill="${ink}"/></g>`,

  // A tide line rising and falling: Dive's own motif.
  tide: (ink) => `
    <style>@keyframes rise{0%,100%{transform:translateY(2px)}50%{transform:translateY(-2px)}}.t{animation:rise 6s ease-in-out infinite}${MOTION}</style>
    <circle cx="20" cy="20" r="12.5" stroke="${ink}" stroke-opacity=".3" fill="none" stroke-width="1.6"/>
    <g class="t"><path d="M8 21c3 0 3-2.4 6-2.4s3 2.4 6 2.4 3-2.4 6-2.4 3 2.4 6 2.4" stroke="${ink}" fill="none" stroke-width="2" stroke-linecap="round"/><path d="M8 26c3 0 3-2.4 6-2.4s3 2.4 6 2.4 3-2.4 6-2.4 3 2.4 6 2.4" stroke="${ink}" stroke-opacity=".45" fill="none" stroke-width="2" stroke-linecap="round"/></g>`,

  // Layers settling: several things stacked into one place.
  layers: (ink) => `
    <style>@keyframes settle{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.6px)}}.l1{animation:settle 5s ease-in-out infinite}.l2{animation:settle 5s ease-in-out infinite .35s}${MOTION}</style>
    <path class="l1" d="m20 8 12 6-12 6-12-6Z" fill="${ink}"/>
    <path class="l2" d="m8 20 12 6 12-6" stroke="${ink}" stroke-opacity=".55" fill="none" stroke-width="2" stroke-linejoin="round"/>
    <path d="m8 26 12 6 12-6" stroke="${ink}" stroke-opacity=".3" fill="none" stroke-width="2" stroke-linejoin="round"/>`,

  // A needle swinging: looking something up.
  compass: (ink) => `
    <style>@keyframes sway{0%,100%{transform:rotate(-16deg)}50%{transform:rotate(16deg)}}.n{animation:sway 7s ease-in-out infinite;transform-origin:20px 20px}${MOTION}</style>
    <circle cx="20" cy="20" r="12.5" stroke="${ink}" stroke-opacity=".35" fill="none" stroke-width="1.6"/>
    <g class="n"><path d="m20 11 3.4 8.2L20 29l-3.4-9.8Z" fill="${ink}"/></g>
    <circle cx="20" cy="20" r="1.8" fill="${ink}" fill-opacity=".55"/>`,

  // Bubbles rising in a flask: things you are trying out.
  flask: (ink) => `
    <style>@keyframes lift{0%{transform:translateY(3px);opacity:0}35%{opacity:.9}100%{transform:translateY(-7px);opacity:0}}.b1{animation:lift 4.5s ease-out infinite}.b2{animation:lift 4.5s ease-out infinite 1.5s}.b3{animation:lift 4.5s ease-out infinite 3s}${MOTION}</style>
    <path d="M16 8v8L9.5 27a2.6 2.6 0 0 0 2.3 4h16.4a2.6 2.6 0 0 0 2.3-4L24 16V8" stroke="${ink}" fill="none" stroke-width="2" stroke-linejoin="round"/>
    <path d="M14 8h12" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>
    <path d="M12.6 24h14.8l2.8 4.6H9.8Z" fill="${ink}" fill-opacity=".35"/>
    <circle class="b1" cx="18" cy="24" r="1.5" fill="${ink}"/>
    <circle class="b2" cx="23" cy="25" r="1.2" fill="${ink}"/>
    <circle class="b3" cx="20.5" cy="23" r="1" fill="${ink}"/>`,

  // A caret blinking in a prompt: where code gets written.
  terminal: (ink) => `
    <style>@keyframes blink{0%,45%{opacity:1}55%,100%{opacity:.15}}.c{animation:blink 1.6s steps(1) infinite}${MOTION}</style>
    <rect x="6" y="9" width="28" height="22" rx="4.5" stroke="${ink}" stroke-opacity=".4" fill="none" stroke-width="1.8"/>
    <path d="m12 17 4 3.5-4 3.5" stroke="${ink}" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <rect class="c" x="19.5" y="23" width="8" height="2.2" rx="1.1" fill="${ink}"/>`,

  // A pulse going out: something being watched.
  pulse: (ink) => `
    <style>@keyframes ring{0%{r:5;opacity:.8}100%{r:15;opacity:0}}.r1{animation:ring 4s ease-out infinite}.r2{animation:ring 4s ease-out infinite 1.3s}${MOTION}</style>
    <circle class="r1" cx="20" cy="20" r="5" stroke="${ink}" fill="none" stroke-width="1.8"/>
    <circle class="r2" cx="20" cy="20" r="5" stroke="${ink}" fill="none" stroke-width="1.8"/>
    <circle cx="20" cy="20" r="4.5" fill="${ink}"/>`,

  // Petals opening in turn: making something look right.
  bloom: (ink) => `
    <style>@keyframes open{0%,100%{transform:scale(.82)}50%{transform:scale(1)}}.p1{animation:open 5.5s ease-in-out infinite;transform-origin:20px 20px}.p2{animation:open 5.5s ease-in-out infinite .5s;transform-origin:20px 20px}.p3{animation:open 5.5s ease-in-out infinite 1s;transform-origin:20px 20px}${MOTION}</style>
    <ellipse class="p1" cx="20" cy="20" rx="5" ry="12" fill="${ink}" fill-opacity=".45"/>
    <ellipse class="p2" cx="20" cy="20" rx="5" ry="12" fill="${ink}" fill-opacity=".45" transform="rotate(60 20 20)"/>
    <ellipse class="p3" cx="20" cy="20" rx="5" ry="12" fill="${ink}" fill-opacity=".45" transform="rotate(120 20 20)"/>
    <circle cx="20" cy="20" r="3" fill="${ink}"/>`,

  // Bars stepping up: numbers you keep an eye on.
  chart: (ink) => `
    <style>@keyframes grow{0%,100%{transform:scaleY(.72)}50%{transform:scaleY(1)}}.g1{animation:grow 5s ease-in-out infinite;transform-origin:bottom}.g2{animation:grow 5s ease-in-out infinite .4s;transform-origin:bottom}.g3{animation:grow 5s ease-in-out infinite .8s;transform-origin:bottom}${MOTION}</style>
    <g transform="translate(0 31)">
      <rect class="g1" x="9" y="-10" width="5.5" height="10" rx="2" fill="${ink}" fill-opacity=".5"/>
      <rect class="g2" x="17.2" y="-17" width="5.5" height="17" rx="2" fill="${ink}"/>
      <rect class="g3" x="25.4" y="-13" width="5.5" height="13" rx="2" fill="${ink}" fill-opacity=".5"/>
    </g>`,

  // A page turning: reading and reference.
  book: (ink) => `
    <style>@keyframes turn{0%,100%{transform:rotateY(0deg)}50%{transform:rotateY(-26deg)}}.pg{animation:turn 6.5s ease-in-out infinite;transform-origin:20px 20px}${MOTION}</style>
    <path d="M20 11c-3-2.2-6.6-3-11-3v20c4.4 0 8 .8 11 3" stroke="${ink}" fill="none" stroke-width="2" stroke-linejoin="round"/>
    <path class="pg" d="M20 11c3-2.2 6.6-3 11-3v20c-4.4 0-8 .8-11 3" fill="${ink}" fill-opacity=".35" stroke="${ink}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M20 11v20" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`,

  // A case with a clasp: the work you are paid for.
  briefcase: (ink) => `
    <style>@keyframes lid{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.4px)}}.h{animation:lid 6s ease-in-out infinite}${MOTION}</style>
    <rect x="6" y="14" width="28" height="18" rx="4" fill="${ink}" fill-opacity=".35"/>
    <path class="h" d="M15 14v-3a2.5 2.5 0 0 1 2.5-2.5h5A2.5 2.5 0 0 1 25 11v3" stroke="${ink}" fill="none" stroke-width="2" stroke-linecap="round"/>
    <path d="M6 21h28" stroke="${ink}" stroke-width="2"/>
    <rect x="17.5" y="19" width="5" height="4" rx="1.4" fill="${ink}"/>`,

  // A signal travelling: things arriving from elsewhere.
  inbox: (ink) => `
    <style>@keyframes drop{0%{transform:translateY(-5px);opacity:0}30%,70%{opacity:1}100%{transform:translateY(0);opacity:0}}.d{animation:drop 4.5s ease-in-out infinite}${MOTION}</style>
    <path d="M7 22h7l2.2 4h7.6l2.2-4h7" stroke="${ink}" fill="none" stroke-width="2" stroke-linejoin="round"/>
    <path d="M7 22 10.5 11h19L33 22v7a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3Z" stroke="${ink}" stroke-opacity=".45" fill="none" stroke-width="1.8" stroke-linejoin="round"/>
    <path class="d" d="M20 6v9m0 0-3-3m3 3 3-3" stroke="${ink}" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
};

/** Every mark a workspace may wear, in picker order. */
export const WORKSPACE_MARKS = Object.keys(marks);

/** One of the marks. */
export type WorkspaceMark = string;

/** A stable index into the marks for any seed, so an old seed still draws. */
function indexFor(seed: string): number {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash % WORKSPACE_MARKS.length;
}

/**
 * The mark `seed` names, or — for a name-derived slug or a seed saved under
 * an older style — a stable one chosen from the same set.
 */
export function markFor(seed: string): string {
  return marks[seed] ? seed : WORKSPACE_MARKS[indexFor(seed || "dive")]!;
}

/** The finished SVG for a workspace, ground in `color` and mark in `ink`. */
export function renderWorkspaceMark(seed: string, color: string, ink: string): string {
  const name = markFor(seed);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="64" height="64">',
    `<rect width="40" height="40" rx="12" fill="${color}"/>`,
    marks[name]!(ink).replace(/\s+/g, " ").trim(),
    "</svg>",
  ].join("");
}
