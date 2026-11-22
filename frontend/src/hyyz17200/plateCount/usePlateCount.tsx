import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Layers, Loader2 } from 'lucide-react';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { getPlateOverview, plateLevel, PLATES_QUERY_KEY, setPrinterPlates } from './api';

// A job finishing elsewhere changes the count; this is how soon the card notices.
const REFRESH_MS = 30_000;
const K = 'hyyz17200.plateCount';

const BADGE =
  'inline-flex flex-shrink-0 items-center gap-1 h-5 px-1.5 rounded-md text-xs font-medium leading-none border tabular-nums transition-colors ';
const LEVEL_CLASS = {
  held: 'bg-red-100 border-red-300 text-red-700 hover:bg-red-200 dark:bg-red-500/20 dark:border-red-400/50 dark:text-red-300 dark:hover:bg-red-500/30',
  low: 'bg-orange-100 border-orange-300 text-orange-700 hover:bg-orange-200 dark:bg-orange-500/20 dark:border-orange-400/40 dark:text-orange-300 dark:hover:bg-orange-500/30',
  ok: 'bg-transparent border-bambu-dark-tertiary text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary',
};

export interface PlateCount {
  /** Next to the printer's name in every card size: clean plates left of the
   *  capacity. A tap refills it to full, like upstream's "plate cleared"
   *  button. Nothing while the printer is not counted. */
  badge: ReactNode;
  /** The card menu's "Set plate count…", only while counted. */
  menuItem: ReactNode;
  /** Render once in the card. */
  dialog: ReactNode;
}

/** The plate count on one printer card. Every card reads the same overview query. */
export function usePlateCount(printer: { id: number; name: string }, onMenuClose: () => void): PlateCount {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canSet = hasPermission('printers:clear_plate');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const { data } = useQuery({ queryKey: PLATES_QUERY_KEY, queryFn: getPlateOverview, refetchInterval: REFRESH_MS });
  const entry = data?.printers.find((p) => p.printer_id === printer.id);
  const counted = !!entry?.counted && entry.plates !== null;
  const capacity = entry?.effective_capacity ?? 10;

  const mutation = useMutation({
    mutationFn: (plates: number | null) => setPrinterPlates(printer.id, plates),
    onSuccess: (_data, plates) => {
      queryClient.invalidateQueries({ queryKey: PLATES_QUERY_KEY });
      showToast(
        plates === null
          ? t(`${K}.toastFilled`, { name: printer.name, count: capacity })
          : t(`${K}.toastSet`, { name: printer.name, count: plates }),
        'success',
      );
      setEditing(false);
    },
    onError: () => showToast(t(`${K}.saveFailed`, { name: printer.name }), 'error'),
  });

  if (!counted || !entry) return { badge: null, menuItem: null, dialog: null };

  const plates = entry.plates ?? 0;
  const full = plates >= capacity;
  const level = plateLevel(entry);
  const state =
    level === 'held'
      ? t(`${K}.titleHeld`)
      : entry.in_use > 0
        ? t(`${K}.titleInUse`, { plates, capacity, count: entry.in_use })
        : t(`${K}.titleLeft`, { plates, capacity });
  const action = !canSet ? t(`${K}.noPermission`) : full ? t(`${K}.titleFull`) : t(`${K}.titleTap`, { count: capacity });

  const badge = (
    <button
      type="button"
      onClick={(e) => {
        // A click on the S card opens its detail view.
        e.stopPropagation();
        if (canSet && !full && !mutation.isPending) mutation.mutate(null);
      }}
      // Not `disabled`: a tap on a disabled button can reach the card, and on
      // the S card that opens its detail view.
      aria-disabled={!canSet || full}
      className={`${BADGE} ${LEVEL_CLASS[level]} ${!canSet || full ? 'cursor-default' : ''}`}
      title={`${state} ${action}`}
      aria-label={t(`${K}.badgeLabel`, { plates, capacity })}
      data-testid="hyyz17200-plate-badge"
    >
      {mutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Layers className="w-3 h-3" />}
      {plates}/{capacity}
    </button>
  );

  const menuItem = (
    <button
      className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 ${
        canSet ? 'hover:bg-bambu-dark-tertiary' : 'opacity-50 cursor-not-allowed'
      }`}
      disabled={!canSet}
      onClick={() => {
        if (!canSet) return;
        onMenuClose();
        setDraft(String(plates));
        setEditing(true);
      }}
      title={!canSet ? t(`${K}.noPermission`) : undefined}
    >
      <Layers className="w-[var(--pc-i4,1rem)] h-[var(--pc-i4,1rem)]" />
      {t(`${K}.menu`)}
    </button>
  );

  const value = draft.trim() === '' ? NaN : Number(draft);
  const valid = Number.isInteger(value) && value >= 0 && value <= capacity;
  const dialog = editing
    ? createPortal(
        // React events cross the portal to the card; an S card would open its detail view.
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmModal
            title={t(`${K}.dialogTitle`, { name: printer.name })}
            message={t(`${K}.dialogMessage`, { capacity })}
            confirmText={t(`${K}.save`)}
            confirmDisabled={!valid}
            isLoading={mutation.isPending}
            onConfirm={() => valid && mutation.mutate(value)}
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
                  if (e.key === 'Enter' && valid) mutation.mutate(value);
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
            {entry.in_use > 0 && <p className="mt-2 text-xs text-bambu-gray">{t(`${K}.dialogInUse`)}</p>}
          </ConfirmModal>
        </div>,
        document.body,
      )
    : null;

  return { badge, menuItem, dialog };
}
