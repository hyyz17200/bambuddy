import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '../../components/Button';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { CALIBRATION_QUERY_KEY, cancelCalibration, OPEN_STATUSES, useCalibrationBatch } from '../calibrationApi';
import { INTAKE_STOPS_QUERY_KEY } from '../printerIntakeApi';
import { ModalShell } from './ModalShell';
import { minutesTaken, STATUS_CLASS, statusText, stepsText } from './calibrationText';

const K = 'hyyz17200.calibration';

/** Where the current batch is, or how the last one ended. */
export function CalibrationProgress({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const { data: batch, isLoading } = useCalibrationBatch();
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const cancel = useMutation({
    mutationFn: cancelCalibration,
    onSuccess: () => {
      showToast(t(`${K}.cancelled`), 'success');
      setConfirmingCancel(false);
    },
    onError: () => showToast(t(`${K}.cancelFailed`), 'error'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: CALIBRATION_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: INTAKE_STOPS_QUERY_KEY });
    },
  });

  const running = batch?.status === 'running';
  const items = batch?.items ?? [];
  const count = (status: string) => items.filter((i) => i.status === status).length;
  const done = items.filter((i) => !OPEN_STATUSES.includes(i.status)).length;

  let summary = '';
  if (batch && running) summary = t(`${K}.summaryRunning`, { done, total: items.length });
  else if (batch?.status === 'finished') {
    summary = t(`${K}.summaryFinished`, { ok: count('succeeded'), failed: count('failed') + count('skipped') });
  } else if (batch?.status === 'cancelled') summary = t(`${K}.summaryCancelled`);

  const footer = confirmingCancel ? (
    <>
      <Button variant="secondary" size="sm" onClick={() => setConfirmingCancel(false)} disabled={cancel.isPending}>
        {t(`${K}.keepGoing`)}
      </Button>
      <Button variant="danger" size="sm" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
        {cancel.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {t(`${K}.cancelConfirm`)}
      </Button>
    </>
  ) : (
    <>
      {running && hasPermission('printers:control') && (
        <Button variant="danger" size="sm" onClick={() => setConfirmingCancel(true)}>
          {t(`${K}.cancel`)}
        </Button>
      )}
      <Button variant="secondary" size="sm" onClick={onClose}>
        {t('common.close')}
      </Button>
    </>
  );

  return (
    <ModalShell title={t(`${K}.title`)} onClose={onClose} busy={cancel.isPending} footer={footer}>
      {isLoading && <Loader2 className="mx-auto h-5 w-5 animate-spin text-bambu-gray" />}
      {!isLoading && !batch && <p className="text-sm text-bambu-gray">{t(`${K}.none`)}</p>}
      {batch && (
        <>
          <p className="text-sm text-white">{summary}</p>
          {running && <p className="mt-1 text-xs text-bambu-gray">{t(`${K}.runningNote`)}</p>}
          {confirmingCancel && <p className="mt-3 text-sm text-yellow-400">{t(`${K}.cancelWarning`)}</p>}
          <ul className="mt-3 divide-y divide-bambu-dark-tertiary rounded-lg bg-bambu-dark text-sm">
            {items.map((item) => {
              const minutes = minutesTaken(item);
              return (
                <li key={item.printer_id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
                  <span className="min-w-[8rem] font-medium text-white">{item.name}</span>
                  <span className={`flex-1 ${STATUS_CLASS[item.status]}`}>{statusText(t, item)}</span>
                  {item.option !== null && (
                    <span className="w-full text-xs text-bambu-gray">
                      {stepsText(t, item.option)}
                      {item.motor_noise_skipped && ` · ${t(`${K}.motorNoiseNotReported`)}`}
                      {minutes !== null && ` · ${t(`${K}.minutes`, { count: minutes })}`}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </ModalShell>
  );
}
