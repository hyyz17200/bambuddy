import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { StickyNote } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { listNoteSummaries, NOTE_SUMMARY_QUERY_KEY } from './api';
import { PrinterNotesDialog } from './PrinterNotesDialog';

// Another browser may add a note; this is how soon the card notices.
const REFRESH_MS = 30_000;

const BADGE =
  'inline-flex flex-shrink-0 items-center gap-0.5 h-5 px-1.5 rounded-md text-xs font-medium leading-none border transition-colors';
/** Something to do: sky blue, since red, amber and yellow already mean offline
 *  or a severe fault, an HMS warning, and not taking jobs or a plate to clear. */
const BADGE_TODO =
  'bg-sky-100 border-sky-300 text-sky-700 hover:bg-sky-200 dark:bg-sky-500/20 dark:border-sky-400/40 dark:text-sky-300 dark:hover:bg-sky-500/30';
/** Only descriptions: quiet grey, nothing to act on. */
const BADGE_INFO =
  'bg-transparent border-bambu-dark-tertiary text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary';

export interface PrinterNotes {
  /** Next to the printer's name in every card size: blue with a count while it
   *  has things to do, a grey icon while it has only descriptions. A click
   *  opens the notes. */
  badge: ReactNode;
  /** The card menu's "Notes…". Closes the menu through `onMenuClose`. */
  menuItem: ReactNode;
  /** Render once in the card. */
  dialog: ReactNode;
}

/** Notes on one printer card. Every card reads the same summary query, so a
 *  farm of cards costs one request per refresh. */
export function usePrinterNotes(printer: { id: number; name: string }, onMenuClose: () => void): PrinterNotes {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('maintenance:read');
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: NOTE_SUMMARY_QUERY_KEY,
    queryFn: listNoteSummaries,
    refetchInterval: REFRESH_MS,
    enabled: canRead,
  });
  const summary = canRead ? data?.find((s) => s.printer_id === printer.id) : undefined;

  const todo = summary?.todo_count ?? 0;
  const badge = summary ? (
    <button
      type="button"
      onClick={(e) => {
        // A click on the S card opens its detail view.
        e.stopPropagation();
        setOpen(true);
      }}
      className={`${BADGE} ${todo > 0 ? BADGE_TODO : BADGE_INFO}`}
      aria-label={
        todo > 0
          ? t('hyyz17200.printerNotes.badgeTodo', { count: todo })
          : t('hyyz17200.printerNotes.badgeInfo', { count: summary.info_count })
      }
      title={summary.latest}
      data-testid="hyyz17200-note-badge"
    >
      <StickyNote className="w-3 h-3" />
      {todo > 0 && todo}
    </button>
  ) : null;

  const menuItem = (
    <button
      className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 ${
        canRead ? 'hover:bg-bambu-dark-tertiary' : 'opacity-50 cursor-not-allowed'
      }`}
      disabled={!canRead}
      onClick={() => {
        if (!canRead) return;
        onMenuClose();
        setOpen(true);
      }}
      title={!canRead ? t('hyyz17200.printerNotes.noPermission') : undefined}
    >
      <StickyNote className="w-[var(--pc-i4,1rem)] h-[var(--pc-i4,1rem)]" />
      {todo > 0 ? t('hyyz17200.printerNotes.menuWithCount', { count: todo }) : t('hyyz17200.printerNotes.menu')}
    </button>
  );

  return {
    badge,
    menuItem,
    dialog: open ? <PrinterNotesDialog printer={printer} onClose={() => setOpen(false)} /> : null,
  };
}
