import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCog } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { MaintenanceJobDialog, type MaintenancePrinter } from './MaintenanceJobDialog';

export interface MaintenanceJob {
  /** The card menu's "Send maintenance G-code". Closes the menu through `onMenuClose`. */
  menuItem: ReactNode;
  /** Render once in the card. */
  dialog: ReactNode;
}

/** "Send maintenance G-code" on one printer card. */
export function useMaintenanceJob(printer: MaintenancePrinter, onMenuClose: () => void): MaintenanceJob {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  // What the send route asks for: controlling the printer, and a queue job.
  const canSend = hasPermission('printers:control') && hasPermission('queue:create');
  const [open, setOpen] = useState(false);

  const menuItem = (
    <button
      className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 ${
        canSend ? 'hover:bg-bambu-dark-tertiary' : 'opacity-50 cursor-not-allowed'
      }`}
      disabled={!canSend}
      onClick={() => {
        if (!canSend) return;
        onMenuClose();
        setOpen(true);
      }}
      title={!canSend ? t('hyyz17200.maintenance.noPermission') : undefined}
    >
      <FileCog className="w-[var(--pc-i4,1rem)] h-[var(--pc-i4,1rem)]" />
      {t('hyyz17200.maintenance.menu')}
    </button>
  );

  return {
    menuItem,
    dialog: open ? <MaintenanceJobDialog printer={printer} onClose={() => setOpen(false)} /> : null,
  };
}
