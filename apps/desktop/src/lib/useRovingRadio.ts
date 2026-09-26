import type { KeyboardEvent } from "react";

/**
 * Where an arrow key moves the choice in a radio group of `count` options,
 * from `index`: Right and Down go forward, Left and Up back, wrapping at the
 * ends; Home and End jump to them. Null for any other key. Pure, so the rule
 * is testable without a DOM.
 */
export function radioStep(count: number, index: number, key: string): number | null {
  if (count === 0) return null;
  const from = index < 0 ? 0 : index;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return index < 0 ? 0 : (from + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return index < 0 ? count - 1 : (from + count - 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** What one option of a roving radio group takes. */
export interface RovingRadioProps {
  tabIndex: number;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Keyboard behaviour for a group of `role="radio"` buttons, as a native radio
 * group has it: the group is one Tab stop (the checked option, or the first
 * when none is), and the arrow keys move the choice and focus together.
 * Without it every swatch and segment was its own Tab stop and the arrows did
 * nothing, which is not what a screen reader announcing "radio group" leads
 * anyone to expect.
 *
 * Returns the props for the option at `index`, in the same order as `values`
 * and as the radios appear inside their `role="radiogroup"`.
 */
export function useRovingRadio<T>(values: readonly T[], value: T, onChange: (value: T) => void): (index: number) => RovingRadioProps {
  return rovingRadio(values, value, onChange);
}

/**
 * `useRovingRadio` without the hook's name, for a component that builds its
 * choices after an early return. It holds no state, so it may be called
 * anywhere.
 */
export function rovingRadio<T>(values: readonly T[], value: T, onChange: (value: T) => void): (index: number) => RovingRadioProps {
  const checked = values.indexOf(value);
  const stop = checked === -1 ? 0 : checked;
  return (index: number) => ({
    tabIndex: index === stop ? 0 : -1,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const next = radioStep(values.length, checked, e.key);
      if (next === null) return;
      e.preventDefault();
      const radios = e.currentTarget.closest("[role='radiogroup']")?.querySelectorAll<HTMLElement>("[role='radio']");
      radios?.[next]?.focus();
      if (next !== checked) onChange(values[next]!);
    },
  });
}
