import { usePrefs } from "../../store/prefs";
import { CharacterBg } from "../CharacterBg";

/**
 * The welcome screen's ground, reused so the flow and the page it lands on
 * share one world: the faint field of "DIVE" characters under a pool of the
 * highlight. The field animates only with motion set to Full, as on the
 * welcome screen.
 */
export function Backdrop({ className = "" }: { className?: string }) {
  const animate = usePrefs((s) => s.prefs.motion === "full");
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      <CharacterBg animated={animate} gridText="DIVE" gap={18} speed={45} colors={{ paletteCount: 1, color1: "#70C2E9" }} style={{ position: "absolute", inset: 0, opacity: 0.04 }} />
      <div className="onboarding-glow absolute inset-0" />
    </div>
  );
}
