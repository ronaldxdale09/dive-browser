import { lazy, Suspense } from "react";
import { usePrefs } from "../../store/prefs";
import { CharacterBg } from "../CharacterBg";

const OrbBurst = lazy(() => import("../OrbBurst").then(({ OrbBurst }) => ({ default: OrbBurst })));

/**
 * The welcome screen's ground, reused so the flow and the page it lands on
 * share one world: the faint field of "DIVE" characters and, when asked, the
 * dot orb, centred at 40% of the height, where the intro leaves its mark. The large field animates only with motion set to Full, as on the
 * welcome screen; the orb follows the effective motion setting on its own.
 */
export function Backdrop({ orb = 0, className = "" }: { orb?: number; className?: string }) {
  const animate = usePrefs((s) => s.prefs.motion === "full");
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      <CharacterBg animated={animate} gridText="DIVE" gap={18} speed={45} colors={{ paletteCount: 1, color1: "#70C2E9" }} style={{ position: "absolute", inset: 0, opacity: 0.04 }} />
      <div className="onboarding-glow absolute inset-0" />
      {orb > 0 && (
        <div className="absolute left-1/2 -translate-x-1/2" style={{ top: `calc(40% - ${orb / 2}px)` }}>
          <Suspense fallback={<div style={{ width: orb, height: orb }} />}>
            <OrbBurst width={orb} height={orb} pointer={{ drag: 0 }} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
