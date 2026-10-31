import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { setHiddenCodes } from './hiddenFaults';
import { HIDDEN_FAULTS_QUERY_KEY, listHiddenFaults } from './hiddenFaultsApi';

const REFRESH_MS = 60_000;

/** Keeps the hidden codes current. Mounted in App rather than Layout because the
 *  full-page /camwall sits outside Layout. A kiosk wall has no user, so with auth
 *  on it never fetches and keeps showing every fault. */
export function HiddenFaultsSync() {
  const { authEnabled, loading, user } = useAuth();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: HIDDEN_FAULTS_QUERY_KEY,
    queryFn: listHiddenFaults,
    enabled: !loading && (!authEnabled || user !== null),
    refetchInterval: REFRESH_MS,
  });

  useEffect(() => {
    if (!data || !setHiddenCodes(data.map((fault) => fault.code))) return;
    // The views read the codes outside React, so nothing tells them they changed.
    // A new field on each cached status is what makes their queries re-render:
    // React Query keeps the old object when a write is deep-equal to it.
    const revision = Date.now();
    queryClient.setQueriesData<object>({ queryKey: ['printerStatus'] }, (status) =>
      status ? { ...status, hyyz17200HiddenFaultsRevision: revision } : status,
    );
  }, [data, queryClient]);

  return null;
}
