import { useEffect, useSyncExternalStore } from 'react';

/** The printer page's Select toggle, lent to buttons outside the page.
 *
 *  Selection is a useState inside PrintersPage, out of reach of the Layout top
 *  bar or anything the fork mounts. The page hands it over here with one line,
 *  and the quick buttons read it. Null while no page lends a toggle, so the
 *  buttons only show on the printer page (card view, with printers:control). */
export interface SelectToggle {
  active: boolean;
  toggle: () => void;
}

let current: SelectToggle | null = null;
let latestToggle: (() => void) | null = null;
const listeners = new Set<() => void>();

// One function for the store's lifetime, so the snapshot only changes when
// `active` or availability does, not on every render of the page.
const toggle = () => latestToggle?.();

function publish(next: SelectToggle | null): void {
  current = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => current;

/** For PrintersPage: lend its Select toggle while `available`. */
export function useHyyz17200SelectToggle(active: boolean, onToggle: () => void, available: boolean): void {
  useEffect(() => {
    latestToggle = onToggle;
  });

  useEffect(() => {
    if (!available) return;
    publish({ active, toggle });
    return () => publish(null);
  }, [active, available]);
}

/** The lent toggle, or null when no page offers one. */
export function useSelectToggle(): SelectToggle | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}
