import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, X, XCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  cancelSliceBatch,
  isOpen,
  listSliceBatches,
  SLICE_BATCHES_QUERY_KEY,
  type SliceBatch,
  type SliceItem,
} from './api';

const K = 'hyyz17200.sliceAsDesigned';
const POLL_MS = 1500;
const ACK_KEY = 'hyyz17200.sliceAsDesigned.dismissed';

// Batch ids restart with Bambuddy, so the start time is part of the key.
const batchKey = (batch: SliceBatch) => `${batch.id}@${batch.created_at}`;

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(ACK_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(keys: Set<string>) {
  try {
    localStorage.setItem(ACK_KEY, JSON.stringify([...keys].slice(-50)));
  } catch {
    // Private mode: the summary just shows again after a reload.
  }
}

function counts(batch: SliceBatch) {
  const c = { total: 0, done: 0, failed: 0, skipped: 0, cancelled: 0, toSlice: 0 };
  for (const item of batch.items) {
    c.total += 1;
    if (item.status === 'done') c.done += 1;
    else if (item.status === 'failed') c.failed += 1;
    else if (item.status === 'skipped') c.skipped += 1;
    else if (item.status === 'cancelled') c.cancelled += 1;
    if (item.status !== 'skipped') c.toSlice += 1;
  }
  return c;
}

/** Progress of batch "slice as designed", and the summary once it ends. App-wide
 *  (AppMount), so it keeps going while the user leaves the file manager. */
export function SliceAsDesignedPanel() {
  const { authEnabled, loading, user, hasPermission } = useAuth();
  const allowed = !loading && (!authEnabled || (user !== null && hasPermission('library:upload')));
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);

  const { data } = useQuery({
    queryKey: SLICE_BATCHES_QUERY_KEY,
    queryFn: listSliceBatches,
    enabled: allowed,
    refetchInterval: (query) => ((query.state.data ?? []).some(isOpen) ? POLL_MS : false),
  });

  // New .gcode.3mf rows: refresh the file list each time another file lands.
  const doneSeen = useRef<number | null>(null);
  const doneNow = (data ?? []).reduce((n, b) => n + counts(b).done, 0);
  useEffect(() => {
    if (doneSeen.current !== null && doneNow !== doneSeen.current) {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
    }
    doneSeen.current = doneNow;
  }, [doneNow, queryClient]);

  const shown = useMemo(() => (data ?? []).filter((b) => !dismissed.has(batchKey(b))), [data, dismissed]);
  if (!allowed || shown.length === 0) return null;

  const dismiss = (batch: SliceBatch) => {
    const next = new Set(dismissed);
    next.add(batchKey(batch));
    setDismissed(next);
    writeDismissed(next);
  };

  return (
    <div className="fixed bottom-4 left-4 z-40 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {shown.map((batch) => (
        <BatchCard key={batchKey(batch)} batch={batch} onDismiss={() => dismiss(batch)} />
      ))}
    </div>
  );
}

function BatchCard({ batch, onDismiss }: { batch: SliceBatch; onDismiss: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const c = counts(batch);
  const open = isOpen(batch);
  const running = batch.items.find((i) => i.status === 'running');
  const finishedCount = c.done + c.failed + c.cancelled;
  const percent = c.toSlice > 0 ? Math.round((finishedCount / c.toSlice) * 100) : 100;
  const problems = batch.items.filter((i) => i.status === 'failed' || i.status === 'skipped');

  const cancel = useMutation({
    mutationFn: () => cancelSliceBatch(batch.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SLICE_BATCHES_QUERY_KEY }),
    onError: () => showToast(t(`${K}.cancelFailed`), 'error'),
  });

  let headline: string;
  if (open) {
    headline =
      batch.status === 'queued'
        ? t(`${K}.queued`)
        : t(`${K}.progress`, { done: finishedCount, total: c.toSlice });
  } else {
    headline = t(batch.status === 'cancelled' ? `${K}.endedCancelled` : `${K}.ended`, { count: c.done });
  }

  return (
    <div className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3 text-sm shadow-lg">
      <div className="flex items-center gap-2">
        {open ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-bambu-green" />
        ) : c.failed > 0 ? (
          <XCircle className="h-4 w-4 shrink-0 text-red-400" />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-bambu-green" />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-medium text-white">{t(`${K}.panelTitle`)}</div>
          <div className="text-xs text-bambu-gray">{headline}</div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
          aria-label={t(`${K}.details`)}
          title={t(`${K}.details`)}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>
        {!open && (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
            aria-label={t(`${K}.close`)}
            title={t(`${K}.close`)}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-bambu-dark-tertiary">
          <div className="h-full bg-bambu-green transition-all" style={{ width: `${percent}%` }} />
        </div>
      )}
      {running && (
        <div className="mt-2 truncate text-xs text-bambu-gray" title={running.name}>
          {t(`${K}.current`, { name: running.name })}
          {running.progress?.stage && running.progress.total_percent
            ? ` · ${running.progress.stage} ${Math.round(running.progress.total_percent)}%`
            : ''}
        </div>
      )}
      {(c.failed > 0 || c.skipped > 0 || c.cancelled > 0) && (
        <div className="mt-1 text-xs">
          {c.failed > 0 && <span className="mr-3 text-red-400">{t(`${K}.failedCount`, { count: c.failed })}</span>}
          {c.skipped > 0 && (
            <span className="mr-3 text-amber-400">{t(`${K}.skippedCount`, { count: c.skipped })}</span>
          )}
          {c.cancelled > 0 && (
            <span className="text-bambu-gray">{t(`${K}.cancelledCount`, { count: c.cancelled })}</span>
          )}
        </div>
      )}

      {expanded && (
        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto border-t border-bambu-dark-tertiary pt-2 text-xs">
          {(problems.length > 0 && !open ? problems : batch.items).map((item) => (
            <ItemRow key={item.file_id} item={item} />
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
            className="text-xs text-bambu-gray underline hover:text-white disabled:opacity-50"
          >
            {t(`${K}.cancel`)}
          </button>
        </div>
      )}
    </div>
  );
}

const STATUS_CLASS: Record<SliceItem['status'], string> = {
  pending: 'text-bambu-gray',
  running: 'text-bambu-green',
  done: 'text-bambu-green',
  failed: 'text-red-400',
  skipped: 'text-amber-400',
  cancelled: 'text-bambu-gray',
};

function ItemRow({ item }: { item: SliceItem }) {
  const { t } = useTranslation();
  const why =
    item.status === 'skipped' && item.reason
      ? t(`${K}.reason.${item.reason}`, item.reason)
      : item.status === 'failed'
        ? item.detail
        : item.status === 'done' && item.output_name
          ? item.output_name
          : null;
  return (
    <li>
      <div className="flex gap-2">
        <span className={`shrink-0 ${STATUS_CLASS[item.status]}`}>{t(`${K}.status.${item.status}`)}</span>
        <span className="min-w-0 flex-1 truncate text-white" title={item.name}>
          {item.name}
        </span>
      </div>
      {why && <div className="ml-2 break-words text-bambu-gray">{why}</div>}
    </li>
  );
}
