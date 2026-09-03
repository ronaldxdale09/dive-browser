import { Smartphone } from "lucide-react";
import { useBrowser } from "../store/browser";
import { selectDevice, useEmulation } from "../store/emulation";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";
import { usePicker } from "./simulator/DevicePicker";

/**
 * The button that opens the device simulator. Lit while a device is on the
 * stage. `label` renders it as an icon-and-word button, for the feature bar.
 */
export function DeviceMenu({ label }: { label?: string } = {}) {
  const activeTab = useBrowser((s) => s.activeTab);
  const sel = useEmulation(selectDevice(activeTab));
  const open = usePicker((s) => s.open);
  const setOpen = usePicker((s) => s.setOpen);
  const active = !!sel;

  return (
    <Tooltip label={active ? "Device simulator (on)" : "Device simulator"}>
      <button
        type="button"
        aria-label="Device simulator"
        aria-pressed={active}
        aria-expanded={open}
        disabled={!activeTab}
        onClick={() => setOpen(!open)}
        className={
          label
            ? "flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent aria-pressed:text-highlight"
            : "grid size-7 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-35 aria-pressed:bg-surface-3 aria-pressed:text-highlight"
        }
      >
        <Icon icon={Smartphone} size={label ? 13 : 15} />
        {label}
      </button>
    </Tooltip>
  );
}
