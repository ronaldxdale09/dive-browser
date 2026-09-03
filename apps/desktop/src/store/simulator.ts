import { create } from "zustand";

interface PickerState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

/**
 * Whether the device picker is up. Shared so the title bar, the stage's tool
 * strip, the palette and the ⌘⇧M chord all open the same panel.
 */
export const usePicker = create<PickerState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
