import { AbsoluteFill, Sequence } from "remotion";
import type { ComponentType } from "react";
import { FPS, T } from "./primitives";
import { Intro, Outro } from "./scenes/bookends";
import { AgentActs, Localhost, Mcp, Workspaces } from "./scenes/build";
import { BugReport, FullPage, Recorder, Recording } from "./scenes/capture";
import { ConsoleVitals, Mobile, Network, Rules } from "./scenes/inspect";

/**
 * The feature reel: one minute, every built-in feature, looping.
 *
 * Bookends take four seconds each; the twelve features share the rest evenly.
 * Order tells a story — organise, connect, delegate, then inspect, then get
 * something out — rather than following the settings menu.
 */
const BOOKEND = 4 * FPS;
const FEATURE = Math.round((60 * FPS - 2 * BOOKEND) / 12);

export const SCENES: { name: string; component: ComponentType; duration: number }[] = [
  { name: "intro", component: Intro, duration: BOOKEND },
  { name: "workspaces", component: Workspaces, duration: FEATURE },
  { name: "mcp", component: Mcp, duration: FEATURE },
  { name: "agent", component: AgentActs, duration: FEATURE },
  { name: "network", component: Network, duration: FEATURE },
  { name: "console", component: ConsoleVitals, duration: FEATURE },
  { name: "rules", component: Rules, duration: FEATURE },
  { name: "mobile", component: Mobile, duration: FEATURE },
  { name: "recording", component: Recording, duration: FEATURE },
  { name: "capture", component: FullPage, duration: FEATURE },
  { name: "recorder", component: Recorder, duration: FEATURE },
  { name: "report", component: BugReport, duration: FEATURE },
  { name: "localhost", component: Localhost, duration: FEATURE },
  { name: "outro", component: Outro, duration: BOOKEND },
];

/** Frame each scene starts on, in the order above. */
const STARTS = SCENES.map((_, i) => SCENES.slice(0, i).reduce((n, s) => n + s.duration, 0));

/** Total length in frames. */
export const DURATION = SCENES.reduce((n, s) => n + s.duration, 0);

/** A still that stands in for the reel when motion is turned off: the workspaces scene, settled. */
export const POSTER_FRAME = BOOKEND + 70;

export function Showcase() {
  return (
    <AbsoluteFill style={{ background: T.ground }}>
      {SCENES.map((s, i) => (
        <Sequence key={s.name} from={STARTS[i] ?? 0} durationInFrames={s.duration} name={s.name}>
          <s.component />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
