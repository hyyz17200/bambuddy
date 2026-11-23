import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '../../components/Card';
import {
  OBICO_SCHEDULER_STATUS_KEY,
  getObicoScheduler,
  seconds,
  targetPerMinute,
  type ObicoSchedulerRow,
} from './obicoScheduler';

const REFRESH_MS = 5_000;

function byName(a: ObicoSchedulerRow, b: ObicoSchedulerRow): number {
  return (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true }) || a.printer_id - b.printer_id;
}

/** How often each printing printer is actually checked, and where a check's
 *  time goes. The numbers live in the backend's memory only. */
export function ObicoSchedulerStatus() {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, isError } = useQuery({
    queryKey: OBICO_SCHEDULER_STATUS_KEY,
    queryFn: getObicoScheduler,
    refetchInterval: REFRESH_MS,
  });

  let body;
  if (isLoading) {
    body = <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;
  } else if (isError || !data) {
    body = <p className="text-sm text-red-400">{t('hyyz17200.obicoScheduler.status.loadFailed')}</p>;
  } else {
    const printing = data.printers.filter((row) => row.printing).sort(byName);
    const rows = showAll ? [...data.printers].sort(byName) : printing;
    const target = targetPerMinute(data);
    body = (
      <>
        <p className="text-sm text-bambu-gray mb-3">
          {data.mode === 'concurrent'
            ? t('hyyz17200.obicoScheduler.status.modeConcurrent', { inFlight: data.in_flight, max: data.max_concurrent })
            : t('hyyz17200.obicoScheduler.status.modeSequential')}
          {' · '}
          {t('hyyz17200.obicoScheduler.status.lastMinute', {
            checks: data.checks_last_minute,
            ok: data.ok_last_minute,
          })}
          {target != null &&
            ` · ${t('hyyz17200.obicoScheduler.status.target', { target, printers: printing.length, interval: data.interval })}`}
          {data.preparing > 0 && ` · ${t('hyyz17200.obicoScheduler.status.preparing', { count: data.preparing })}`}
        </p>
        {rows.length === 0 ? (
          <p className="text-sm text-bambu-gray">{t('hyyz17200.obicoScheduler.status.nothing')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-bambu-gray border-b border-bambu-dark-tertiary">
                  <th className="py-2 pr-3 font-normal">{t('hyyz17200.obicoScheduler.status.printer')}</th>
                  <th className="py-2 pr-3 font-normal">{t('hyyz17200.obicoScheduler.status.period')}</th>
                  <th className="py-2 pr-3 font-normal">{t('hyyz17200.obicoScheduler.status.lastResult')}</th>
                  <th className="py-2 pr-3 font-normal">{t('hyyz17200.obicoScheduler.status.capture')}</th>
                  <th className="py-2 pr-3 font-normal">{t('hyyz17200.obicoScheduler.status.ml')}</th>
                  <th className="py-2 pr-3 font-normal">{t('hyyz17200.obicoScheduler.status.waits')}</th>
                  <th className="py-2 font-normal">{t('hyyz17200.obicoScheduler.status.checks')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.printer_id} className="border-b border-bambu-dark-tertiary/50" data-printer={row.printer_id}>
                    <td className="py-2 pr-3 text-white whitespace-nowrap">
                      {row.name ?? `#${row.printer_id}`}
                      {row.in_flight && <span className="ml-2 text-xs text-bambu-green">●</span>}
                    </td>
                    <td className="py-2 pr-3 text-bambu-gray whitespace-nowrap">{seconds(row.ok_period ?? row.period)}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {row.consecutive_failures > 0 ? (
                        <span className="text-amber-400">
                          {t('hyyz17200.obicoScheduler.status.failing', { count: row.consecutive_failures })}
                        </span>
                      ) : row.last_ok_age == null ? (
                        <span className="text-bambu-gray">—</span>
                      ) : (
                        <span className="text-bambu-gray">
                          {t('hyyz17200.obicoScheduler.status.ago', { seconds: Math.round(row.last_ok_age) })}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-bambu-gray whitespace-nowrap">{seconds(row.capture_avg, 2)}</td>
                    <td className="py-2 pr-3 text-bambu-gray whitespace-nowrap">{seconds(row.ml_avg, 2)}</td>
                    <td className="py-2 pr-3 text-bambu-gray whitespace-nowrap">
                      {row.waits} / {row.overruns}
                    </td>
                    <td className="py-2 text-bambu-gray whitespace-nowrap">
                      {row.ok} / {row.checks}
                      {row.dropped_actions > 0 &&
                        ` · ${t('hyyz17200.obicoScheduler.status.dropped', { count: row.dropped_actions })}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.printers.length > printing.length && (
          <button
            type="button"
            className="mt-3 text-xs text-bambu-green hover:underline"
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll
              ? t('hyyz17200.obicoScheduler.status.showPrinting')
              : t('hyyz17200.obicoScheduler.status.showAll', { count: data.printers.length })}
          </button>
        )}
      </>
    );
  }

  return (
    <div className="mt-6">
      <h3 className="text-base text-white mb-1">{t('hyyz17200.obicoScheduler.status.title')}</h3>
      <p className="text-xs text-bambu-gray mb-3">{t('hyyz17200.obicoScheduler.status.hint')}</p>
      <Card>
        <CardContent>{body}</CardContent>
      </Card>
    </div>
  );
}
