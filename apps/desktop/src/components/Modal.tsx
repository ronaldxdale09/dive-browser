import { createContext, useContext, useRef } from "react";
import type { FormEventHandler, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";

const CloseContext = createContext<(() => void) | null>(null);

/** The close the enclosing `<Modal>` runs: fade out, then `onClose`. */
export function useModalClose(): () => void {
  const close = useContext(CloseContext);
  if (!close) throw new Error("useModalClose must be used inside <Modal>");
  return close;
}

export interface ModalProps {
  /** aria-label of the dialog. */
  label?: string | undefined;
  /** aria-labelledby of the dialog, when a visible heading names it. */
  labelledBy?: string | undefined;
  /** aria-describedby of the dialog. */
  describedBy?: string | undefined;
  /** Stacking class of the scrim; default `z-50`. */
  layer?: string | undefined;
  /** Runs after the fade (at once under reduced motion or `fade={false}`). */
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  /** Fade out before closing; default true. */
  fade?: boolean | undefined;
  /** Classes placing the dialog inside the scrim; default centres it. */
  backdropClassName?: string | undefined;
  /** The dialog panel's classes. */
  className?: string | undefined;
  /** What a press on the scrim does; default is to close. */
  onBackdrop?: (() => void) | undefined;
  /** Mark the panel as a native overlay region (`data-native-overlay`). */
  nativeOverlay?: boolean | undefined;
  /** Whether Escape closes; default true. */
  escapeCloses?: boolean | undefined;
  /** Makes the dialog panel a `<form>` that runs this on submit. */
  onSubmit?: FormEventHandler<HTMLFormElement> | undefined;
  /** aria-busy of the dialog. */
  busy?: boolean | undefined;
  /** Either the content, or a function of the fading `close` for content written in place. */
  children: ReactNode | ((close: () => void) => ReactNode);
}

/**
 * The full-screen dialog frame every chrome dialog shares: a scrim that
 * closes on press, focus held inside, the page view covered (so the CEF
 * page cannot paint over it), and a short fade out. Children that need to
 * close with the fade call `useModalClose()`.
 */
export function Modal({ label, labelledBy, describedBy, layer = "z-50", onClose, initialFocus, fade = true, backdropClassName, className, onBackdrop, escapeCloses = true, nativeOverlay = false, onSubmit, busy, children }: ModalProps) {
  const root = useRef<HTMLDivElement>(null);
  // Hooks are unconditional: the fade timer simply never starts when unused.
  const faded = useFadeClose(onClose);
  const close = fade ? faded.close : onClose;
  const fadeClass = fade ? faded.className : "";
  useCoversContent(true);
  useFocusTrap(root, { initialFocus, onEscape: escapeCloses ? close : undefined });
  const content = typeof children === "function" ? children(close) : children;
  const panel = {
    role: "dialog",
    "aria-modal": true,
    "aria-label": label,
    "aria-labelledby": labelledBy,
    "aria-describedby": describedBy,
    "aria-busy": busy,
    "data-native-overlay": nativeOverlay ? "" : undefined,
    onMouseDown: (e: ReactMouseEvent) => e.stopPropagation(),
    className,
  };
  return (
    <CloseContext.Provider value={close}>
      <div ref={root} className={`overlay-backdrop fixed inset-0 ${layer} ${backdropClassName ?? "grid place-items-center"} ${fadeClass}`.trim()} onMouseDown={onBackdrop ?? close}>
        {onSubmit ? <form {...panel} onSubmit={onSubmit}>{content}</form> : <div {...panel}>{content}</div>}
      </div>
    </CloseContext.Provider>
  );
}
