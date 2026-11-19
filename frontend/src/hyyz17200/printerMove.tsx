import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { MoveToLocationDialog, type MovablePrinter } from './MoveToLocationDialog';

export interface PrinterMove {
  /** The card menu's "Move to location". Closes the menu through `onMenuClose`. */
  menuItem: ReactNode;
  /** Render once in the card. */
  dialog: ReactNode;
}

/** "Move to location" on one printer card: one tap on a location tile moves it. */
export function usePrinterMove(printer: MovablePrinter, onMenuClose: () => void): PrinterMove {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canMove = hasPermission('printers:update');
  const [open, setOpen] = useState(false);

  const menuItem = (
    <button
      className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 ${
        canMove ? 'hover:bg-bambu-dark-tertiary' : 'opacity-50 cursor-not-allowed'
      }`}
      disabled={!canMove}
      onClick={() => {
        if (!canMove) return;
        onMenuClose();
        setOpen(true);
      }}
      title={!canMove ? t('printers.permission.noEdit') : undefined}
    >
      <MapPin className="w-[var(--pc-i4,1rem)] h-[var(--pc-i4,1rem)]" />
      {t('hyyz17200.printerMove.menu')}
    </button>
  );

  return {
    menuItem,
    dialog: open ? <MoveToLocationDialog printer={printer} onClose={() => setOpen(false)} /> : null,
  };
}
