import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { Printer } from '../../api/client';
import { Button } from '../../components/Button';
import { useToast } from '../../contexts/ToastContext';
import {
  BED_LEVELING,
  CALIBRATION_QUERY_KEY,
  MOTOR_NOISE,
  previewCalibration,
  startCalibration,
  VIBRATION,
  type CalibrationOptions,
} from '../calibrationApi';
import { INTAKE_STOPS_QUERY_KEY } from '../printerIntakeApi';
import { Hyyz17200RequestError } from '../request';
import { ModalShell } from './ModalShell';
import { stepsText } from './calibrationText';

const K = 'hyyz17200.calibration';
const START_ERRORS = ['batch_running', 'kill_switch', 'nothing_selected'];

interface Props {
  /** In the order they are calibrated. */
  printers: Printer[];
  onClose: () => void;
  /** The batch started, or one was already running: show its progress. */
  onShowProgress: () => void;
  /** There is an earlier batch whose results can be opened. */
  hasEarlierBatch: boolean;
}

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 py-1">
      <input type="checkbox" className="mt-0.5 accent-bambu-green" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm text-white">{label}</span>
        {hint && <span className="block text-xs text-bambu-gray">{hint}</span>}
      </span>
    </label>
  );
}

/** Choose what to calibrate on the selected printers, and start. */
export function CalibrationStart({ printers, onClose, onShowProgress, hasEarlierBatch }: Props) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [options, setOptions] = useState<CalibrationOptions>({
    bed_leveling: true,
    vibration: true,
    motor_noise: true,
    resume_intake: true,
  });
  const [bedClear, setBedClear] = useState(false);
  const set = (key: keyof CalibrationOptions) => (value: boolean) => setOptions((o) => ({ ...o, [key]: value }));

  // In maintenance a printer is disconnected and would only wait: left out.
  const targets = printers.filter((p) => p.is_active !== false);
  const inMaintenance = printers.filter((p) => p.is_active === false);
  const ids = targets.map((p) => p.id);

  const preview = useQuery({
    queryKey: ['hyyz17200', 'calibration-preview', ids],
    queryFn: () => previewCalibration(ids),
    enabled: ids.length > 0,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const start = useMutation({
    mutationFn: () => startCalibration(ids, options),
    onSuccess: (batch) => {
      queryClient.setQueryData(CALIBRATION_QUERY_KEY, batch);
      queryClient.invalidateQueries({ queryKey: INTAKE_STOPS_QUERY_KEY });
      showToast(t(`${K}.started`, { count: ids.length }), 'success');
      onShowProgress();
    },
    onError: (error) => {
      const code = error instanceof Hyyz17200RequestError ? error.detail : undefined;
      showToast(t(code && START_ERRORS.includes(code) ? `${K}.error.${code}` : `${K}.error.failed`), 'error');
      queryClient.invalidateQueries({ queryKey: CALIBRATION_QUERY_KEY });
    },
  });

  const info = preview.data;
  const anyStep = options.bed_leveling || options.vibration || options.motor_noise;
  const canStart =
    !!info && !info.kill_switch && !info.batch_running && ids.length > 0 && anyStep && bedClear && !start.isPending;

  const plan = (motorNoise: boolean | null) =>
    (options.bed_leveling ? BED_LEVELING : 0) |
    (options.vibration ? VIBRATION : 0) |
    (options.motor_noise && motorNoise === true ? MOTOR_NOISE : 0);

  const footer = (
    <>
      {hasEarlierBatch && (
        <Button variant="ghost" size="sm" className="mr-auto" onClick={onShowProgress} disabled={start.isPending}>
          {t(`${K}.lastResults`)}
        </Button>
      )}
      <Button variant="secondary" size="sm" onClick={onClose} disabled={start.isPending}>
        {t('common.cancel')}
      </Button>
      <Button size="sm" onClick={() => start.mutate()} disabled={!canStart}>
        {start.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {t(`${K}.start`, { count: ids.length })}
      </Button>
    </>
  );

  return (
    <ModalShell title={t(`${K}.startTitle`, { count: ids.length })} onClose={onClose} busy={start.isPending} footer={footer}>
      <p className="text-sm text-bambu-gray">{t(`${K}.intro`)}</p>

      <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-medium uppercase text-bambu-gray">{t(`${K}.steps`)}</p>
          <Check checked={options.bed_leveling} onChange={set('bed_leveling')} label={t(`${K}.bedLeveling`)} />
          <Check checked={options.vibration} onChange={set('vibration')} label={t(`${K}.vibration`)} />
          <Check
            checked={options.motor_noise}
            onChange={set('motor_noise')}
            label={t(`${K}.motorNoise`)}
            hint={t(`${K}.motorNoiseHint`)}
          />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium uppercase text-bambu-gray">{t(`${K}.afterwards`)}</p>
          <Check
            checked={options.resume_intake}
            onChange={set('resume_intake')}
            label={t(`${K}.resumeIntake`)}
            hint={t(`${K}.resumeIntakeHint`)}
          />
        </div>
      </div>

      {preview.isLoading && (
        <p className="mt-4 flex items-center gap-2 text-sm text-bambu-gray">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t(`${K}.asking`)}
        </p>
      )}
      {preview.isError && <p className="mt-4 text-sm text-red-400">{t(`${K}.previewFailed`)}</p>}
      {info?.kill_switch && <p className="mt-4 text-sm text-red-400">{t(`${K}.error.kill_switch`)}</p>}
      {info?.batch_running && (
        <p className="mt-4 text-sm text-yellow-400">
          {t(`${K}.error.batch_running`)}{' '}
          <button type="button" className="underline" onClick={onShowProgress}>
            {t(`${K}.showProgress`)}
          </button>
        </p>
      )}

      {info && (
        <ol className="mt-4 divide-y divide-bambu-dark-tertiary rounded-lg bg-bambu-dark text-sm">
          {info.printers.map((p, index) => {
            const option = plan(p.motor_noise);
            return (
              <li key={p.printer_id} className="px-3 py-2">
                <span className="text-bambu-gray">{index + 1}.</span> <span className="font-medium text-white">{p.name}</span>
                {p.model && <span className="ml-2 text-xs text-bambu-gray">{p.model}</span>}
                <span className="block text-xs text-bambu-gray">
                  {option ? stepsText(t, option) : t(`${K}.detail.motor_noise_unsupported`)}
                  {options.motor_noise && p.motor_noise !== true && option !== 0 && ` · ${t(`${K}.motorNoiseNotReported`)}`}
                </span>
                {p.blocker && <span className="block text-xs text-yellow-400">{t(`${K}.waitsFor`, { reason: t(`${K}.blocker.${p.blocker}`) })}</span>}
              </li>
            );
          })}
        </ol>
      )}
      {inMaintenance.length > 0 && (
        <p className="mt-2 text-xs text-bambu-gray">
          {t(`${K}.leftOutMaintenance`, { names: inMaintenance.map((p) => p.name).join(', ') })}
        </p>
      )}

      <div className="mt-4 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2">
        <Check checked={bedClear} onChange={setBedClear} label={t(`${K}.bedClear`)} hint={t(`${K}.bedClearHint`)} />
      </div>
    </ModalShell>
  );
}
