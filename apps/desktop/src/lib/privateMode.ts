/** Set only by the native host in trusted chrome, before any application script. */
export function isPrivateWindow(): boolean {
  return (window as Window & { __DIVE_PRIVATE__?: boolean }).__DIVE_PRIVATE__ === true;
}
