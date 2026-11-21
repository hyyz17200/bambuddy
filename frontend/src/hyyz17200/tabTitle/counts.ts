import type { HMSError } from '../../api/client';
import { filterKnownHMSErrors } from '../../components/HMSErrorModal';
import type { StateCounts } from './tabTitleSettings';

export interface CountedStatus {
  connected: boolean;
  state: string | null;
  hms_errors?: HMSError[];
}

/** The printer page's StatusSummaryBar rules (PrintersPage.tsx), so the tab and
 *  the page agree: a printer whose status hasn't loaded yet counts nowhere but
 *  `total`; one with a fault counts as `error` and also in its state; FAILED
 *  without a fault is a finished print (a cancel). Faults go through
 *  filterKnownHMSErrors, which leaves out the hidden ones like every badge. */
export function countPrinterStates(statuses: (CountedStatus | undefined)[]): StateCounts {
  const counts: StateCounts = { printing: 0, paused: 0, finished: 0, idle: 0, error: 0, offline: 0, total: statuses.length };
  for (const status of statuses) {
    if (status === undefined) continue;
    if (!status.connected) {
      counts.offline++;
      continue;
    }
    const faulted = status.hms_errors ? filterKnownHMSErrors(status.hms_errors).length > 0 : false;
    if (faulted) counts.error++;
    switch (status.state) {
      case 'RUNNING':
        counts.printing++;
        break;
      case 'PAUSE':
        counts.paused++;
        break;
      case 'FINISH':
        counts.finished++;
        break;
      case 'FAILED':
        if (!faulted) counts.finished++;
        break;
      default:
        counts.idle++;
    }
  }
  return counts;
}
