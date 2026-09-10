import logo from "../assets/logo.png";
import { isPrivateWindow } from "../lib/privateMode";
import { PrivateBadge } from "./PrivateMode";

/**
 * The mark and the name, for the title strip above the rail: the one place
 * the window says what it is. Reads as a label, not a control, so it sits in
 * the drag region and moves the window like the rest of the strip. A private
 * window carries its badge here too, since the strip is what identifies it.
 */
export function Wordmark() {
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-tauri-drag-region="true">
      <img src={logo} alt="" width={16} height={16} draggable={false} className="size-4 shrink-0 rounded-[4px]" data-tauri-drag-region="true" />
      <span className="truncate text-[13px] font-semibold tracking-tight text-ink" data-tauri-drag-region="true">Dive</span>
      {isPrivateWindow() && <PrivateBadge />}
    </span>
  );
}
