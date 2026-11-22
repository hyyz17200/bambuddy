import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Layers } from 'lucide-react';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { isCounted, parseWhole, platesLeft, setPlatesRemaining, type PlatePrinter } from './api';

const K = 'hyyz17200.plateCount';

export interface PlateCount {
  /** The card menu's "Set plate count…", only on a printer with upstream's
   *  plate changer capacity set. */
  menuItem: ReactNode;
  /** Render once in the card. */
  dialog: ReactNode;
}

/** Set any number of plates from the card menu. Upstream's own chip on the card
 *  shows the count and refills it to full; this sets any number in between. */
export function usePlateCount(printer: PlatePrinter, onMenuClose: () => void): PlateCount {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  // Upstream's PATCH /printers/{id}, which sets plates_remaining, needs this one.
  const canSet = hasPermission('printers:update');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const mutation = useMutation({
    mutationFn: (plates: number) => setPlatesRemaining(printer.id, plates),
    onSuccess: (_data, plates) => {
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      showToast(t(`${K}.toastSet`, { name: printer.name, count: plates }), 'success');
      setEditing(false);
    },
    onError: () => showToast(t(`${K}.saveFailed`, { name: printer.name }), 'error'),
  });

  if (!isCounted(printer)) return { menuItem: null, dialog: null };
  const capacity = printer.plate_capacity;

  const menuItem = (
    <button
      className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 ${
        canSet ? 'hover:bg-bambu-dark-tertiary' : 'opacity-50 cursor-not-allowed'
      }`}
      disabled={!canSet}
      onClick={() => {
        if (!canSet) return;
        onMenuClose();
        setDraft(String(platesLeft(printer) ?? capacity));
        setEditing(true);
      }}
      title={!canSet ? t(`${K}.noPermission`) : undefined}
    >
      <Layers className="w-[var(--pc-i4,1rem)] h-[var(--pc-i4,1rem)]" />
      {t(`${K}.menu`)}
    </button>
  );

  const value = parseWhole(draft, 0, capacity);
  const dialog = editing
    ? createPortal(
        // React events cross the portal to the card; an S card would open its detail view.
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmModal
            title={t(`${K}.dialogTitle`, { name: printer.name })}
            message={t(`${K}.dialogMessage`, { capacity })}
            confirmText={t(`${K}.save`)}
            confirmDisabled={value === null}
            isLoading={mutation.isPending}
            onConfirm={() => value !== null && mutation.mutate(value)}
            onCancel={() => setEditing(false)}
          >
            <div className="mt-3 flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={capacity}
                step={1}
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && value !== null) mutation.mutate(value);
                }}
                aria-label={t(`${K}.inputLabel`)}
                className="w-24 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-bambu-green"
              />
              <span className="text-sm text-bambu-gray">/ {capacity}</span>
              <button
                type="button"
                onClick={() => setDraft(String(capacity))}
                className="ml-auto px-3 py-1.5 text-sm rounded-lg border border-bambu-dark-tertiary text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary"
              >
                {t(`${K}.fill`, { count: capacity })}
              </button>
            </div>
            <p className="mt-2 text-xs text-bambu-gray">{t(`${K}.dialogHint`)}</p>
          </ConfirmModal>
        </div>,
        document.body,
      )
    : null;

  return { menuItem, dialog };
}
