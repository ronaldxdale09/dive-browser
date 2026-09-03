import { TransitionSeries, springTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { AbsoluteFill } from "remotion";
import type { ComponentType } from "react";
import { FPS, T } from "./primitives";
import type { SceneProps } from "./primitives";
import { Intro, Outro } from "./scenes/bookends";
import { AgentActs, Localhost, Mcp, Workspaces } from "./scenes/build";
import { BugReport, FullPage, Recorder, Recording } from "./scenes/capture";
import { ConsoleVitals, Mobile, Network, Rules } from "./scenes/inspect";

/**
 * The feature reel: one minute, every built-in feature, looping.
 *
 * Scenes are a `<TransitionSeries>` with a short crossfade at each cut, so
 * the timeline is the sum of the sequences minus the overlaps — the numbers
 * below are chosen so that comes to exactly sixty seconds.
 *
 * The order leads with what is most visible and most immediately useful —
 * recording, capture, the phone simulator, the agent — then how Dive is
 * organised and connected, then the inspection tools, then the artefacts you
 * take away from it.
 */
export const TRANSITION = 14;
export const FEATURE = 145;
export const BOOKEND = 121;

export const FEATURES: { name: string; component: ComponentType<SceneProps> }[] = [
  { name: "recording", component: Recording },
  { name: "capture", component: FullPage },
  { name: "mobile", component: Mobile },
  { name: "agent", component: AgentActs },
  { name: "workspaces", component: Workspaces },
  { name: "mcp", component: Mcp },
  { name: "network", component: Network },
  { name: "console", component: ConsoleVitals },
  { name: "rules", component: Rules },
  { name: "recorder", component: Recorder },
  { name: "report", component: BugReport },
  { name: "localhost", component: Localhost },
];

/** Sequence lengths in series order: intro, features, outro. */
export const SEQUENCES = [BOOKEND, ...FEATURES.map(() => FEATURE), BOOKEND];

/** Total length in frames: sequences minus the overlap of every transition between them. */
export const DURATION = SEQUENCES.reduce((n, d) => n + d, 0) - TRANSITION * (SEQUENCES.length - 1);

/** A still that stands in for the reel when motion is turned off: the first feature, settled. */
export const POSTER_FRAME = BOOKEND + 80;

const cut = (key: string) => (
  <TransitionSeries.Transition key={key} presentation={fade()} timing={springTiming({ config: { damping: 200 }, durationInFrames: TRANSITION })} />
);

export function Showcase() {
  return (
    <AbsoluteFill style={{ background: T.ground }}>
      <TransitionSeries>
        <TransitionSeries.Sequence name="intro" durationInFrames={BOOKEND} premountFor={FPS}>
          <Intro />
        </TransitionSeries.Sequence>
        {FEATURES.flatMap((f, i) => [
          cut(`cut-${f.name}`),
          <TransitionSeries.Sequence key={f.name} name={f.name} durationInFrames={FEATURE} premountFor={FPS}>
            <f.component index={i + 1} />
          </TransitionSeries.Sequence>,
        ])}
        {cut("cut-outro")}
        <TransitionSeries.Sequence name="outro" durationInFrames={BOOKEND} premountFor={FPS}>
          <Outro />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
}
