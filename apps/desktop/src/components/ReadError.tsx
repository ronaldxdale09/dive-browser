/** A dock panel's failed read, with a way to ask again. */
export function ReadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs">
      <span className="text-danger">{message}</span>
      <button type="button" onClick={onRetry} className="pressable rounded-full border border-line-2 px-2 py-0.5 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink">
        Try again
      </button>
    </div>
  );
}
