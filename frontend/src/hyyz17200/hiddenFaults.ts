/** The fault codes hidden on this instance (upstream issue #3269). HMSErrorModal's
 *  `counts()` reads this synchronously for every badge, pip and camera wall tile,
 *  so a hidden fault stops counting but stays listed, collapsed, in the HMS modal.
 *  HiddenFaultsSync keeps it filled. */
let hiddenCodes: ReadonlySet<string> = new Set();

/** Same rule as the backend's `is_hidden_code`: an 8-digit entry also covers the
 *  hms[] form of that fault, a 16-digit entry is exact. */
export function isHiddenFault(error: { full_code?: string }): boolean {
  const code = (error.full_code ?? '').toUpperCase();
  return hiddenCodes.has(code) || (code.length === 16 && hiddenCodes.has(code.slice(0, 4) + code.slice(12)));
}

/** Returns whether the set changed, which is when the printer views must redraw. */
export function setHiddenCodes(codes: string[]): boolean {
  const next = new Set(codes);
  const changed = next.size !== hiddenCodes.size || codes.some((code) => !hiddenCodes.has(code));
  hiddenCodes = next;
  return changed;
}
