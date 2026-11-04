import type { TFunction } from 'i18next';
import { parseUTCDate } from '../../utils/date';
import { BED_LEVELING, MOTOR_NOISE, VIBRATION, type CalibrationItem } from '../calibrationApi';

const K = 'hyyz17200.calibration';

/** "Bed leveling, Vibration compensation" for an option bitmask. */
export function stepsText(t: TFunction, option: number): string {
  const steps = [
    option & BED_LEVELING ? t(`${K}.bedLeveling`) : null,
    option & VIBRATION ? t(`${K}.vibration`) : null,
    option & MOTOR_NOISE ? t(`${K}.motorNoise`) : null,
  ].filter(Boolean);
  return steps.join(t(`${K}.separator`));
}

export function statusText(t: TFunction, item: CalibrationItem): string {
  switch (item.status) {
    case 'waiting':
      return item.blocker ? t(`${K}.blocker.${item.blocker}`) : t(`${K}.status.waiting`);
    case 'running':
      return item.stage ? `${t(`${K}.status.running`)} · ${item.stage}` : t(`${K}.status.running`);
    case 'failed':
      return t(`${K}.status.failed`, { reason: t(`${K}.detail.${item.detail ?? 'unknown'}`) });
    case 'skipped':
      return t(`${K}.detail.${item.detail ?? 'motor_noise_unsupported'}`);
    case 'cancelled':
      return item.detail === 'intake_resumed' ? t(`${K}.detail.intake_resumed`) : t(`${K}.status.cancelled`);
    default:
      return t(`${K}.status.${item.status}`);
  }
}

export const STATUS_CLASS: Record<CalibrationItem['status'], string> = {
  waiting: 'text-bambu-gray',
  starting: 'text-blue-400',
  running: 'text-blue-400',
  succeeded: 'text-bambu-green',
  failed: 'text-red-400',
  skipped: 'text-yellow-400',
  cancelled: 'text-bambu-gray',
};

/** Whole minutes from the command to the end, or to now while it runs. */
export function minutesTaken(item: CalibrationItem, now = Date.now()): number | null {
  const start = parseUTCDate(item.started_at);
  if (!start) return null;
  const end = parseUTCDate(item.finished_at)?.getTime() ?? now;
  return Math.max(0, Math.round((end - start.getTime()) / 60_000));
}
