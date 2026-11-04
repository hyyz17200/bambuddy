import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge } from 'lucide-react';
import { useCalibrationBatch } from '../calibrationApi';
import { CalibrationProgress } from './CalibrationProgress';

/** The card's "Waiting to calibrate" / "Calibrating" pill while the printer is
 *  in a running batch; clicking it opens the batch's progress. */
export function useCalibrationCard(printerId: number): { pill: ReactNode; dialog: ReactNode } {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { data: batch } = useCalibrationBatch();

  const item = batch?.status === 'running' ? batch.items.find((i) => i.printer_id === printerId) : undefined;
  const active = item?.status === 'starting' || item?.status === 'running';
  const waiting = item?.status === 'waiting';

  const pill =
    active || waiting ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs transition-colors ${
          active
            ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-500/30'
            : 'bg-gray-100 dark:bg-bambu-dark-tertiary text-gray-600 dark:text-bambu-gray-light hover:bg-gray-200 dark:hover:bg-bambu-dark'
        }`}
        title={t('hyyz17200.calibration.pillTitle')}
      >
        <Gauge className={`w-[var(--pc-i3,0.75rem)] h-[var(--pc-i3,0.75rem)] ${active ? 'animate-pulse' : ''}`} />
        {t(active ? 'hyyz17200.calibration.pillRunning' : 'hyyz17200.calibration.pillWaiting')}
      </button>
    ) : null;

  return { pill, dialog: open ? <CalibrationProgress onClose={() => setOpen(false)} /> : null };
}
