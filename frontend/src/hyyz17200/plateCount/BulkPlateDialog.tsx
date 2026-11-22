import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { PrinterNameList } from '../bulkActions/PrinterNameList';
import { runBatch } from '../bulkActions/runBatch';
import { isCounted, parseWhole, setPlates, type PlatePrinter } from './api';

const K = 'hyyz17200.plateCount.bulk';

/** Refill the selected printers' plate changers (upstream's count, #3575). The
 *  number is typed in, which is also the confirmation: a printer that holds
 *  fewer gets its own capacity. Printers without a capacity are skipped.
 *  Without printers:update only a full refill is possible (upstream's refill). */
export function BulkPlateDialog({ printers, onClose }: { printers: PlatePrinter[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canUpdate = hasPermission('printers:update');
  const canRefill = hasPermission('printers:clear_plate');
  const counted = printers.filter(isCounted);
  const capacities = [...new Set(counted.map((p) => p.plate_capacity))].sort((a, b) => a - b);
  const largest = capacities.length ? Math.max(...capacities) : 0;
  const [draft, setDraft] = useState(String(largest));
  const [saving, setSaving] = useState(false);

  const value = canUpdate ? parseWhole(draft, 0, largest) : largest;
  const valid = value !== null && counted.length > 0;

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    const done = await runBatch(counted, (p) => setPlates(p, value, canRefill));
    setSaving(false);
    queryClient.invalidateQueries({ queryKey: ['printers'] });
    if (done.failed.length) {
      showToast(
        t(`${K}.failedSome`, { count: done.failed.length, names: done.failed.map((f) => f.printer.name).join(', ') }),
        'error',
      );
    } else {
      showToast(t(`${K}.done`, { count: done.ok.length, plates: value }), 'success');
      onClose();
    }
  };

  return (
    <ConfirmModal
      title={t(`${K}.title`, { count: counted.length })}
      message={counted.length ? t(canUpdate ? `${K}.message` : `${K}.messageFull`) : t(`${K}.none`)}
      confirmText={t(`${K}.confirm`, { count: value ?? 0 })}
      confirmDisabled={!valid}
      isLoading={saving}
      onConfirm={save}
      onCancel={onClose}
    >
      {counted.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm text-white">
            {t(`${K}.plates`)}
            <input
              type="number"
              min={0}
              max={largest}
              step={1}
              value={canUpdate ? draft : String(largest)}
              disabled={!canUpdate}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
              className="w-24 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-bambu-green disabled:opacity-50"
            />
          </label>
          {capacities.length > 1 && (
            <p className="text-xs text-bambu-gray">{t(`${K}.mixedCapacity`, { capacities: capacities.join(', ') })}</p>
          )}
        </div>
      )}
      <PrinterNameList printers={counted} />
      {printers.length > counted.length && (
        <p className="mt-2 text-xs text-bambu-gray">{t(`${K}.skipped`, { count: printers.length - counted.length })}</p>
      )}
    </ConfirmModal>
  );
}
