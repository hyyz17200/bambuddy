import { useEffect } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { ENHANCED_SETTINGS_QUERY_KEY, getEnhancedSettings } from '../enhancedSettingsApi';
import { countPrinterStates } from './counts';
import { APP_TITLE, setOwnedTitle } from './ownTitle';
import { formatTabTitle, normalizeTabTitle } from './tabTitleSettings';

/** While the tab title override is on, the tab shows the printer-state counts.
 *  Off, it does nothing at all: no requests, the title left to upstream.
 *
 *  Like upstream's usePrintProgressTitle, the statuses are not polled: the
 *  WebSocket writes ['printerStatus', id] directly. They are not refetched on
 *  window focus either, which with a farm would be a request per printer every
 *  time the tab comes back. */
export function TabTitleSync() {
  const { authEnabled, loading, user } = useAuth();
  const { data } = useQuery({
    queryKey: ENHANCED_SETTINGS_QUERY_KEY,
    queryFn: getEnhancedSettings,
    enabled: !loading && (!authEnabled || user !== null),
  });
  const settings = normalizeTabTitle(data?.tab_title);
  const on = settings.enabled;

  const { data: printers } = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters, enabled: on });
  const statuses = useQueries({
    queries: (on ? printers ?? [] : []).map((printer) => ({
      queryKey: ['printerStatus', printer.id],
      queryFn: () => api.getPrinterStatus(printer.id),
      refetchOnWindowFocus: false,
    })),
  });

  const title = on && printers ? formatTabTitle(settings, countPrinterStates(statuses.map((q) => q.data)), APP_TITLE) : null;

  useEffect(() => {
    setOwnedTitle(title);
  }, [title]);

  useEffect(() => () => setOwnedTitle(null), []);

  return null;
}
