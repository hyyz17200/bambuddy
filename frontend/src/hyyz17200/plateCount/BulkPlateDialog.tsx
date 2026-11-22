import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useToast } from '../../contexts/ToastContext';
import { PrinterNameList } from '../bulkActions/PrinterNameList';
import { getPlateOverview, PLATES_QUERY_KEY, setManyPlates } from './api';

const K = 'hyyz17200.plateCount.bulk';

/** Refill the selected printers' plates. The number is typed in, which is also
 *  the confirmation: a printer that holds fewer gets its own capacity. Printers
 *  not counted are listed as skipped. */
export function BulkPlateDialog({
  printers,
  onClose,
}: {
  printers: { id: number; name: string }[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: PLATES_QUERY_KEY, queryFn: getPlateOverview });
  const byId = new Map(data?.printers.map((p) => [p.printer_id, p]));
  const counted = printers.filter((p) => byId.get(p.id)?.counted);
  const capacities = [...new Set(counted.map((p) => byId.get(p.id)!.effective_capacity))];
  const largest = capacities.length ? Math.max(...capacities) : 10;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const text = draft ?? (data ? String(largest) : '');
  const value = text.trim() === '' ? NaN : Number(text);
  const valid = Number.isInteger(value) && value >= 0 && value <= largest && counted.length > 0;

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      const { updated } = await setManyPlates(
        counted.map((p) => p.id),
        value,
      );
      showToast(t(`${K}.done`, { count: updated.length, plates: value }), 'success');
      onClose();
    } catch {
      showToast(t(`${K}.failed`), 'error');
    } finally {
      setSaving(false);
      queryClient.invalidateQueries({ queryKey: PLATES_QUERY_KEY });
    }
  };

  return (
    <ConfirmModal
      title={t(`${K}.title`, { count: counted.length })}
      message={counted.length ? t(`${K}.message`) : t(`${K}.none`)}
      confirmText={t(`${K}.confirm`, { count: Number.isInteger(value) ? value : 0 })}
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
              value={text}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
              className="w-24 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-bambu-green"
            />
          </label>
          {capacities.length > 1 && (
            <p className="text-xs text-bambu-gray">{t(`${K}.mixedCapacity`, { capacities: capacities.sort((a, b) => a - b).join(', ') })}</p>
          )}
        </div>
      )}
      <PrinterNameList printers={counted} />
      {printers.length > counted.length && (
        <p className="mt-2 text-xs text-bambu-gray">
          {t(`${K}.skipped`, { count: printers.length - counted.length })}
        </p>
      )}
    </ConfirmModal>
  );
}
