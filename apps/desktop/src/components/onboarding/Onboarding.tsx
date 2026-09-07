import { lazy, Suspense, useEffect } from "react";
import { useCoversContent } from "../../lib/overlay";
import { useBrowser } from "../../store/browser";
import { shouldOnboard, useOnboarding } from "../../store/onboarding";
import { usePrefs } from "../../store/prefs";
import { Shell } from "./Shell";
import { StartScreen } from "./StartScreen";
import { ProfileStep } from "./ProfileStep";
import { ImportStep } from "./ImportStep";
import { WorkspaceStep } from "./WorkspaceStep";
import { FeaturesStep } from "./FeaturesStep";

// The Remotion player is only worth its weight on a first launch.
const IntroScene = lazy(() => import("./IntroScene").then(({ IntroScene }) => ({ default: IntroScene })));

/**
 * The first-run flow: a five-second intro, a start screen, then profile,
 * import, workspace and a look at the features. It opens on its own when the
 * preferences say it never completed, and again from Settings › About.
 * Nothing underneath is reachable while it is up: it covers the whole
 * window, chrome included, so the person meets Dive one thing at a time.
 */
export function Onboarding() {
  const stage = useOnboarding((s) => s.stage);
  const begin = useOnboarding((s) => s.begin);
  const loaded = usePrefs((s) => s.loaded);
  const onboarded = usePrefs((s) => s.prefs.onboarded);
  const ready = useBrowser((s) => s.ready);
  useCoversContent(stage !== null);

  useEffect(() => {
    if (stage === null && shouldOnboard(loaded, onboarded, ready)) begin();
  }, [stage, loaded, onboarded, ready, begin]);

  if (stage === null) return null;
  // One start screen for both stages, at one place in the tree, so the flip
  // from intro to start never remounts it: the intro fades out over a screen
  // that is already there, and nothing underneath ever shows.
  if (stage === "intro" || stage === "start") {
    return (
      <>
        <StartScreen behind={stage === "intro"} />
        {stage === "intro" && (
          <Suspense fallback={<div className="fixed inset-0 z-[61] bg-ground" aria-label="Loading intro" />}>
            <IntroScene />
          </Suspense>
        )}
      </>
    );
  }
  return (
    <Shell>
      {stage === "profile" && <ProfileStep />}
      {stage === "import" && <ImportStep />}
      {stage === "workspace" && <WorkspaceStep />}
      {stage === "features" && <FeaturesStep />}
    </Shell>
  );
}
