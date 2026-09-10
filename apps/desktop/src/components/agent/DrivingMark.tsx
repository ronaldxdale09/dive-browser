import { AgentIcon } from "./AgentIcon";

/**
 * The mark on a tab an agent is driving.
 *
 * It stands where the favicon does, because the question it answers -- which
 * of these is moving on its own? -- is asked while scanning the list, and an
 * extra badge beside the favicon is not seen at that size. The site is still
 * named beside it, so nothing is lost by borrowing the slot for as long as
 * the run lasts.
 *
 * Dive's own agent mark rather than a robot: the aperture is already what the
 * agent is called everywhere else in the app, and it is a shape that reads at
 * fourteen pixels, which a face does not. The sweep is what says "working" --
 * a ring that fills and empties around it, the way a run actually feels, over
 * a core that breathes. Both stop under reduced motion, leaving a mark that
 * is still clearly not a favicon.
 */
export function DrivingMark({ size = 14 }: { size?: number }) {
  const ring = size + 6;
  return (
    <span
      role="img"
      aria-label="An agent is working in this tab"
      className="relative grid shrink-0 place-items-center text-highlight"
      style={{ width: size, height: size }}
    >
      <style>{`
        @keyframes dive-driving-sweep { to { transform: rotate(360deg); } }
        @keyframes dive-driving-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
      `}</style>
      <svg
        aria-hidden
        width={ring}
        height={ring}
        viewBox="0 0 24 24"
        className="pointer-events-none absolute motion-safe:animate-[dive-driving-sweep_1.6s_linear_infinite] motion-reduce:animate-none"
      >
        {/* An arc, not a circle: the gap is what makes the rotation visible. */}
        <circle
          cx="12"
          cy="12"
          r="10.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="17 49"
          opacity="0.9"
        />
        <circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.16" />
      </svg>
      <AgentIcon
        size={size - 3}
        variant="glow"
        className="motion-safe:animate-[dive-driving-pulse_1.8s_ease-in-out_infinite] motion-reduce:animate-none"
      />
    </span>
  );
}
