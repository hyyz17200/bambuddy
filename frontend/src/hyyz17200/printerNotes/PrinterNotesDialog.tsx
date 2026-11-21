import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, CircleCheck, Info, ListTodo, Loader2, Pencil, RotateCcw, StickyNote, Trash2, Wrench, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../../api/client';
import type { MaintenanceLogEntry } from '../../api/client';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useUiSettings } from '../../hooks/useUiSettings';
import { formatDateTime, parseUTCDate, type TimeFormat } from '../../utils/date';
import {
  addPrinterNote,
  deletePrinterNote,
  listPrinterNotes,
  NOTE_KINDS,
  NOTE_MAX_LENGTH,
  NOTES_QUERY_KEY,
  printerNotesQueryKey,
  updatePrinterNote,
  type NoteKind,
  type PrinterNote,
} from './api';

// Upstream's maintenance resets shown in the history; the rest are on the
// Maintenance page.
const LOG_LIMIT = 50;

const TEXTAREA =
  'w-full px-3 py-2 text-sm bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white placeholder-bambu-gray focus:outline-none focus:ring-2 focus:ring-bambu-green/50 focus:border-bambu-green resize-y';
const ICON_BUTTON =
  'p-1 rounded text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const PRIMARY =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-bambu-green text-white hover:bg-bambu-green/80 disabled:opacity-50 disabled:cursor-not-allowed';
const SECONDARY =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-bambu-dark-tertiary text-bambu-gray hover:text-white disabled:opacity-50 disabled:cursor-not-allowed';

const KIND_ICON: Record<NoteKind, LucideIcon> = { info: Info, todo: ListTodo, done: CircleCheck };
/** The note row's frame per kind; todo matches the card badge's sky blue. */
const KIND_ROW: Record<NoteKind, string> = {
  info: 'border-bambu-dark-tertiary bg-bambu-dark-tertiary/40',
  todo: 'border-sky-400/40 bg-sky-500/10',
  done: 'border-bambu-dark-tertiary bg-bambu-dark/30',
};
const KIND_PICKED: Record<NoteKind, string> = {
  info: 'bg-bambu-dark-tertiary text-white border-bambu-gray/60',
  todo: 'bg-sky-500/20 text-sky-300 border-sky-400/60',
  done: 'bg-bambu-green/20 text-bambu-green border-bambu-green/60',
};

type HistoryItem =
  | { kind: 'note'; at: number; note: PrinterNote }
  | { kind: 'log'; at: number; entry: MaintenanceLogEntry };

const timeOf = (value: string | null | undefined) => parseUTCDate(value)?.getTime() ?? 0;

/** Ctrl+Enter (Cmd+Enter on a Mac) submits, as in most comment boxes. */
const isSubmitKey = (e: React.KeyboardEvent) => e.key === 'Enter' && (e.ctrlKey || e.metaKey);

function KindPicker({ value, onChange, disabled }: { value: NoteKind; onChange: (kind: NoteKind) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t('hyyz17200.printerNotes.kindLabel')} className="inline-flex gap-1">
      {NOTE_KINDS.map((kind) => {
        const Icon = KIND_ICON[kind];
        const picked = kind === value;
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={picked}
            disabled={disabled}
            onClick={() => onChange(kind)}
            title={t(`hyyz17200.printerNotes.kindHint.${kind}`)}
            className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors disabled:opacity-50 ${
              picked ? KIND_PICKED[kind] : 'border-transparent text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {t(`hyyz17200.printerNotes.kind.${kind}`)}
          </button>
        );
      })}
    </div>
  );
}

/** One printer's notes: descriptions, then things to do, then a history of
 *  done notes and upstream's maintenance resets, newest first.
 *
 *  Rendered into `document.body`, since a card being dragged or sorted carries a
 *  `transform`. React still bubbles events from a portal to the card, whose
 *  click opens the S card's detail view, so the overlay stops them. */
export function PrinterNotesDialog({ printer, onClose }: { printer: { id: number; name: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const { data: settings } = useUiSettings();
  const timeFormat: TimeFormat = settings?.time_format || 'system';
  const canCreate = hasPermission('maintenance:create');
  const canUpdate = hasPermission('maintenance:update');
  const canDelete = hasPermission('maintenance:delete');

  const [draft, setDraft] = useState('');
  const [draftKind, setDraftKind] = useState<NoteKind>('info');
  const [editing, setEditing] = useState<{ id: number; text: string; kind: NoteKind } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PrinterNote | null>(null);

  const notesQuery = useQuery({
    queryKey: printerNotesQueryKey(printer.id),
    queryFn: () => listPrinterNotes(printer.id),
  });
  // Its own key: upstream's log dialog keeps an infinite query under
  // ['maintenanceLog', id], a different shape in the same cache.
  const logQuery = useQuery({
    queryKey: ['hyyz17200', 'maintenance-log', printer.id],
    queryFn: () => api.getMaintenanceLog(printer.id, { limit: LOG_LIMIT }),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: NOTES_QUERY_KEY });
  const failed = (error: unknown) =>
    showToast(t('hyyz17200.printerNotes.saveFailed', { error: error instanceof Error ? error.message : String(error) }), 'error');

  const addMutation = useMutation({
    mutationFn: () => addPrinterNote(printer.id, draft.trim(), draftKind),
    onSuccess: () => {
      // The kind stays: several notes of one kind in a row are common.
      setDraft('');
      refresh();
    },
    onError: failed,
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, change }: { id: number; change: { body?: string; kind?: NoteKind } }) =>
      updatePrinterNote(printer.id, id, change),
    onSuccess: (_note, { change }) => {
      if (change.body !== undefined) setEditing(null);
      refresh();
    },
    onError: failed,
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => deletePrinterNote(printer.id, id),
    onSuccess: () => {
      setPendingDelete(null);
      refresh();
    },
    onError: failed,
  });
  const busy = addMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  // Escape never throws away typed text, and closes a confirmation first.
  const keepOpen = busy || pendingDelete !== null || editing !== null || draft.trim() !== '';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !keepOpen) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keepOpen, onClose]);

  const notes = useMemo(() => notesQuery.data ?? [], [notesQuery.data]);
  const infoNotes = notes.filter((n) => n.kind === 'info');
  const todoNotes = notes.filter((n) => n.kind === 'todo');
  const history = useMemo<HistoryItem[]>(() => {
    const items: HistoryItem[] = notes
      .filter((n) => n.kind === 'done')
      .map((note) => ({ kind: 'note', at: timeOf(note.resolved_at ?? note.created_at), note }));
    for (const entry of logQuery.data?.items ?? []) items.push({ kind: 'log', at: timeOf(entry.performed_at), entry });
    return items.sort((a, b) => b.at - a.at);
  }, [notes, logQuery.data]);
  const moreLog = Math.max(0, (logQuery.data?.total ?? 0) - (logQuery.data?.items.length ?? 0));

  const submitDraft = () => {
    if (draft.trim() && !busy) addMutation.mutate();
  };
  const saveEdit = () => {
    if (!editing || !editing.text.trim() || busy) return;
    const note = notes.find((n) => n.id === editing.id);
    updateMutation.mutate({
      id: editing.id,
      change: { body: editing.text.trim(), ...(note && note.kind !== editing.kind ? { kind: editing.kind } : {}) },
    });
  };

  const renderNote = (note: PrinterNote) => {
    const isEditing = editing?.id === note.id;
    // One-click moves between todo and done; anything else goes through Edit.
    const quick =
      note.kind === 'todo'
        ? { to: 'done' as const, label: t('hyyz17200.printerNotes.resolve'), Icon: Check }
        : note.kind === 'done'
          ? { to: 'todo' as const, label: t('hyyz17200.printerNotes.reopen'), Icon: RotateCcw }
          : null;
    return (
      <li
        key={`note-${note.id}`}
        className={`rounded-lg border px-3 py-2 ${KIND_ROW[note.kind] ?? KIND_ROW.info}`}
        data-testid={`hyyz17200-note-${note.id}`}
      >
        {isEditing ? (
          <div className="space-y-2">
            <textarea
              value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              onKeyDown={(e) => {
                if (isSubmitKey(e)) saveEdit();
                else if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditing(null);
                }
              }}
              maxLength={NOTE_MAX_LENGTH}
              rows={3}
              autoFocus
              aria-label={t('hyyz17200.printerNotes.editLabel')}
              className={TEXTAREA}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <KindPicker value={editing.kind} onChange={(kind) => setEditing({ ...editing, kind })} disabled={busy} />
              <div className="flex gap-2">
                <button type="button" className={SECONDARY} onClick={() => setEditing(null)} disabled={busy}>
                  {t('common.cancel')}
                </button>
                <button type="button" className={PRIMARY} onClick={saveEdit} disabled={busy || !editing.text.trim()}>
                  {updateMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t('common.save')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <p className="flex-1 min-w-0 text-sm text-white whitespace-pre-wrap break-words">{note.body}</p>
              <div className="flex flex-shrink-0 items-center gap-0.5 -my-0.5">
                {canUpdate && quick && (
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    disabled={busy}
                    onClick={() => updateMutation.mutate({ id: note.id, change: { kind: quick.to } })}
                    aria-label={quick.label}
                    title={quick.label}
                  >
                    <quick.Icon className="w-4 h-4" />
                  </button>
                )}
                {canUpdate && (
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    disabled={busy}
                    onClick={() => setEditing({ id: note.id, text: note.body, kind: note.kind })}
                    aria-label={t('common.edit')}
                    title={t('common.edit')}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    className={`${ICON_BUTTON} hover:!text-red-400`}
                    disabled={busy}
                    onClick={() => setPendingDelete(note)}
                    aria-label={t('common.delete')}
                    title={t('common.delete')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-bambu-gray">
              <span>
                {note.created_by ? `${note.created_by} · ` : ''}
                {formatDateTime(note.created_at, timeFormat)}
              </span>
              {note.edited_at && (
                <span title={formatDateTime(note.edited_at, timeFormat)}>{t('hyyz17200.printerNotes.edited')}</span>
              )}
              {note.kind === 'done' && note.resolved_at && (
                <span className="text-bambu-green">
                  {note.resolved_by
                    ? t('hyyz17200.printerNotes.resolvedBy', {
                        user: note.resolved_by,
                        time: formatDateTime(note.resolved_at, timeFormat),
                      })
                    : t('hyyz17200.printerNotes.resolvedAt', { time: formatDateTime(note.resolved_at, timeFormat) })}
                </span>
              )}
            </div>
          </>
        )}
      </li>
    );
  };

  const renderLog = (entry: MaintenanceLogEntry) => (
    <li key={`log-${entry.id}`} className="rounded-lg border border-dashed border-bambu-dark-tertiary bg-bambu-dark/20 px-3 py-2">
      <div className="flex items-center gap-1.5 text-sm text-white">
        <Wrench className="w-3.5 h-3.5 text-bambu-gray flex-shrink-0" />
        <span className="font-medium">{t('hyyz17200.printerNotes.maintenanceDone', { task: entry.maintenance_type_name })}</span>
      </div>
      {entry.notes && <p className="mt-1 text-sm text-white/90 whitespace-pre-wrap break-words">{entry.notes}</p>}
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-bambu-gray">
        <span>
          {entry.performed_by_username ? `${entry.performed_by_username} · ` : ''}
          {formatDateTime(entry.performed_at, timeFormat)}
        </span>
        <span>{t('maintenance.atPrintHours', { hours: entry.hours_at_maintenance.toFixed(1) })}</span>
      </div>
    </li>
  );

  const section = (kind: NoteKind, count: number, body: React.ReactNode, empty: string) => {
    const Icon = KIND_ICON[kind];
    return (
      <section aria-label={t(`hyyz17200.printerNotes.heading.${kind}`)}>
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-bambu-gray mb-2">
          <Icon className="w-3.5 h-3.5" />
          {t(`hyyz17200.printerNotes.heading.${kind}`)}
          {count > 0 && <span className="font-normal normal-case">({count})</span>}
        </h3>
        {count === 0 ? <p className="text-sm text-bambu-gray">{empty}</p> : body}
      </section>
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        e.stopPropagation();
        if (!keepOpen) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hyyz17200-notes-title"
        className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 p-4 border-b border-bambu-dark-tertiary">
          <h2 id="hyyz17200-notes-title" className="min-w-0 text-lg font-semibold text-white flex items-center gap-2">
            <StickyNote className="w-5 h-5 text-sky-400 flex-shrink-0" />
            <span className="truncate">{t('hyyz17200.printerNotes.title', { name: printer.name })}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t('common.close')}
            className="p-2 -m-1 rounded-lg text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-5">
          {canCreate && (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => isSubmitKey(e) && submitDraft()}
                maxLength={NOTE_MAX_LENGTH}
                rows={3}
                autoFocus
                placeholder={t(`hyyz17200.printerNotes.placeholder.${draftKind}`)}
                aria-label={t('hyyz17200.printerNotes.newNote')}
                className={TEXTAREA}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <KindPicker value={draftKind} onChange={setDraftKind} disabled={busy} />
                <button type="button" className={PRIMARY} onClick={submitDraft} disabled={busy || !draft.trim()}>
                  {addMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t('hyyz17200.printerNotes.add')}
                </button>
              </div>
            </div>
          )}

          {notesQuery.isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-6 h-6 animate-spin text-bambu-gray" />
            </div>
          ) : notesQuery.isError ? (
            <p className="text-sm text-red-400">{t('hyyz17200.printerNotes.loadFailed')}</p>
          ) : (
            <>
              {section(
                'info',
                infoNotes.length,
                <ul className="space-y-2">{infoNotes.map(renderNote)}</ul>,
                t('hyyz17200.printerNotes.empty.info'),
              )}
              {section(
                'todo',
                todoNotes.length,
                <ul className="space-y-2">{todoNotes.map(renderNote)}</ul>,
                t('hyyz17200.printerNotes.empty.todo'),
              )}
              {section(
                'done',
                history.length,
                <>
                  <ul className="space-y-2">
                    {history.map((item) => (item.kind === 'note' ? renderNote(item.note) : renderLog(item.entry)))}
                  </ul>
                  {moreLog > 0 && (
                    <p className="mt-2 text-xs text-bambu-gray">{t('hyyz17200.printerNotes.moreLog', { count: moreLog })}</p>
                  )}
                </>,
                t('hyyz17200.printerNotes.empty.done'),
              )}
            </>
          )}
        </div>

        {pendingDelete && (
          <ConfirmModal
            title={t('hyyz17200.printerNotes.deleteTitle')}
            message={t('hyyz17200.printerNotes.deleteMessage', { body: pendingDelete.body.slice(0, 80) })}
            confirmText={t('common.delete')}
            variant="danger"
            overlayZIndex="z-[60]"
            isLoading={deleteMutation.isPending}
            onConfirm={() => deleteMutation.mutate(pendingDelete.id)}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
