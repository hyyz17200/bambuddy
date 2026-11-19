import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '../components/Card';
import {
  GROUP_ORDER,
  getAutoUnloadStatus,
  sortRows,
  viewOf,
  type AutoUnloadResult,
  type AutoUnloadRow,
} from './autoUnloadApi';

const REFRESH_MS = 15_000;

const GROUP_CLASS: Record<string, string> = {
  attention: 'text-amber-400',
  unloading: 'text-bambu-green',
  waiting: 'text-white',
  quiet: 'text-bambu-gray',
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** What the auto unload loop sees on every printer, so a printer that is not
 *  unloaded says why. The state lives in the backend's memory only. */
export function AutoUnloadStatus() {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['hyyz17200', 'auto-unload', 'status'],
    queryFn: getAutoUnloadStatus,
    refetchInterval: REFRESH_MS,
  });

  const reasonText = (key: string, row?: AutoUnloadRow) =>
    t(`hyyz17200.autoUnload.status.reason.${key}`, {
      defaultValue: key,
      status: row?.ams_status_main ?? '?',
    });

  const resultText = (last: AutoUnloadResult) => {
    const detail =
      last.result === 'blocked' && last.detail ? reasonText(last.detail) : (last.detail ?? '');
    return t(`hyyz17200.autoUnload.status.result.${last.result}`, { defaultValue: last.result, detail });
  };

  let body;
  if (isLoading) {
    body = <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;
  } else if (isError || !data) {
    body = <p className="text-sm text-red-400">{t('hyyz17200.autoUnload.status.loadFailed')}</p>;
  } else if (!data.enabled) {
    body = <p className="text-sm text-bambu-gray">{t('hyyz17200.autoUnload.status.off')}</p>;
  } else {
    const rows = sortRows(data.printers);
    const counts = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0])) as Record<string, number>;
    rows.forEach((row) => (counts[viewOf(row).group] += 1));
    const shown = showAll ? rows : rows.filter((row) => viewOf(row).group !== 'quiet');

    body = (
      <>
        <p className="text-sm text-bambu-gray mb-3">
          {t('hyyz17200.autoUnload.status.summary', {
            attention: counts.attention,
            unloading: counts.unloading,
            waiting: counts.waiting,
            quiet: counts.quiet,
          })}
        </p>
        {shown.length === 0 ? (
          <p className="text-sm text-bambu-gray">{t('hyyz17200.autoUnload.status.nothingToShow')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-bambu-gray border-b border-bambu-dark-tertiary">
                  <th className="py-2 pr-3 font-normal">{t('hyyz17200.autoUnload.status.printer')}</th>
                  <th className="py-2 pr-3 font-normal">{t('hyyz17200.autoUnload.status.status')}</th>
                  <th className="py-2 pr-3 font-normal">{t('hyyz17200.autoUnload.status.idle')}</th>
                  <th className="py-2 font-normal">{t('hyyz17200.autoUnload.status.last')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => {
                  const view = viewOf(row);
                  const minutes = row.idle_seconds == null ? null : Math.floor(row.idle_seconds / 60);
                  return (
                    <tr key={row.printer_id} className="border-b border-bambu-dark-tertiary/50" data-printer={row.printer_id}>
                      <td className="py-2 pr-3 text-white whitespace-nowrap">{row.name}</td>
                      <td className={`py-2 pr-3 ${GROUP_CLASS[view.group]}`}>{reasonText(view.key, row)}</td>
                      <td className="py-2 pr-3 text-bambu-gray whitespace-nowrap">
                        {minutes == null
                          ? '—'
                          : view.group === 'waiting'
                            ? t('hyyz17200.autoUnload.status.idleOf', { minutes, total: data.idle_minutes })
                            : t('hyyz17200.autoUnload.status.idleMinutes', { minutes })}
                      </td>
                      <td className="py-2 text-bambu-gray">
                        {row.last ? `${resultText(row.last)} · ${formatTime(row.last.at)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {counts.quiet > 0 && (
          <button
            type="button"
            className="mt-3 text-xs text-bambu-green hover:underline"
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll
              ? t('hyyz17200.autoUnload.status.showFewer')
              : t('hyyz17200.autoUnload.status.showAll', { count: rows.length })}
          </button>
        )}
      </>
    );
  }

  return (
    <div className="mt-6">
      <h3 className="text-base text-white mb-1">{t('hyyz17200.autoUnload.status.title')}</h3>
      <p className="text-xs text-bambu-gray mb-3">{t('hyyz17200.autoUnload.status.hint')}</p>
      <Card>
        <CardContent>{body}</CardContent>
      </Card>
    </div>
  );
}
