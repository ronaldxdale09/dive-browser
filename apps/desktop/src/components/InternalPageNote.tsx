/** Pages Dive draws itself have no page to measure; the dock says so instead of erroring. */
export function isInternalPage(url: string | undefined | null): boolean {
  return Boolean(url?.startsWith("dive://"));
}

export function InternalPageNote({ what }: { what: string }) {
  return <div className="px-3 py-2 text-xs text-ink-3">This is one of Dive&rsquo;s own pages; {what} apply to websites.</div>;
}
