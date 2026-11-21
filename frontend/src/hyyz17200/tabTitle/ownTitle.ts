/** Keeps document.title on the fork's text while the tab title override is on.
 *
 *  Upstream's usePrintProgressTitle (hooks/) writes the title whenever the
 *  soonest print's percentage changes, if "Print progress in tab" is on. Rather
 *  than touch it, a MutationObserver puts our text straight back after any
 *  other write. Its favicon ring is left alone. The standalone camera and
 *  overlay pages set their own title (the printer's name) and are not touched. */

// index.html's title, read before anything changes it.
export const APP_TITLE = document.title || 'Bambuddy';

let desired: string | null = null;
let observer: MutationObserver | null = null;

const STANDALONE = /^\/(camera|overlay)\//;
const onStandalonePage = () => STANDALONE.test(window.location.pathname);

function enforce() {
  if (desired === null || onStandalonePage()) return;
  if (document.title !== desired) document.title = desired;
}

/** Take the tab title over with `next`, or with null hand it back. */
export function setOwnedTitle(next: string | null): void {
  const previous = desired;
  desired = next;
  if (next === null) {
    observer?.disconnect();
    observer = null;
    if (previous !== null && document.title === previous && !onStandalonePage()) document.title = APP_TITLE;
    return;
  }
  if (!observer) {
    observer = new MutationObserver(enforce);
    // document.title = … replaces the <title>'s text node; a new <title> is a head child.
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  }
  enforce();
}
