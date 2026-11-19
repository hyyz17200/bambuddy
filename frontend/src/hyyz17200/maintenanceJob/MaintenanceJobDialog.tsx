import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileBox, Loader2, Send, X } from 'lucide-react';
import { api } from '../../api/client';
import type { LibraryFileListItem, LibraryFolderTree } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { formatDuration } from '../../utils/date';
import { isGcodeCompatible } from '../../utils/printer';
import { mapModelCode } from '../../utils/printerModel';
import { ENHANCED_SETTINGS_QUERY_KEY, getEnhancedSettings } from '../enhancedSettingsApi';
import { Hyyz17200RequestError } from '../request';
import {
  MAINTENANCE_SECTION,
  isMaintenanceFile,
  normalizeMaintenance,
  rememberClearsPlate,
  rememberedClearsPlate,
  sendMaintenanceJob,
} from './maintenanceApi';

export type MaintenancePrinter = { id: number; name: string; model?: string | null };

// Codes the send route answers with; anything else shows the generic message.
const KNOWN_ERRORS = new Set([
  'no_folder',
  'not_in_folder',
  'not_sliced',
  'wrong_model',
  'file_not_found',
  'printer_not_found',
  'review_required',
  'queue_busy',
  'offline',
  'busy',
  'maintenance',
  'deleted',
  'drying',
  'interlock',
]);

/** Each folder's path below `rootId` ("" for the root itself), from the folder tree. */
function subfolderPaths(tree: LibraryFolderTree[], rootId: number): Map<number, string> {
  const paths = new Map<number, string>();
  const walk = (folders: LibraryFolderTree[], path: string | null) => {
    for (const folder of folders) {
      const inside = folder.id === rootId ? '' : path === null ? null : path ? `${path} / ${folder.name}` : folder.name;
      if (inside !== null) paths.set(folder.id, inside);
      walk(folder.children ?? [], inside);
    }
  };
  walk(tree, null);
  return paths;
}

/** Pick a sliced file from the maintenance folder and send it to the printer now.
 *  Rendered into `document.body`, like the other card dialogs. */
export function MaintenanceJobDialog({ printer, onClose }: { printer: MaintenancePrinter; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<LibraryFileListItem | null>(null);
  const [clearsPlate, setClearsPlate] = useState(false);

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ENHANCED_SETTINGS_QUERY_KEY,
    queryFn: getEnhancedSettings,
  });
  const folderId = normalizeMaintenance(settings?.[MAINTENANCE_SECTION]).folder_id;

  const { data: files, isLoading: filesLoading } = useQuery({
    queryKey: ['hyyz17200', 'maintenance-files', folderId],
    queryFn: () => api.getLibraryFiles(folderId, true, undefined, undefined, true),
    enabled: folderId !== null,
  });
  const { data: folders } = useQuery({
    queryKey: ['hyyz17200', 'maintenance-folders'],
    queryFn: api.getLibraryFolders,
    enabled: folderId !== null,
  });

  const model = printer.model ? mapModelCode(printer.model) || printer.model : null;
  const { offered, otherModels } = useMemo(() => {
    const sliced = (files ?? []).filter((file) => isMaintenanceFile(file.filename));
    const fits = sliced.filter((file) => isGcodeCompatible(file.sliced_for_model, model));
    return { offered: fits, otherModels: sliced.length - fits.length };
  }, [files, model]);
  const paths = useMemo(
    () => (folders && folderId !== null ? subfolderPaths(folders, folderId) : new Map<number, string>()),
    [folders, folderId],
  );

  const mutation = useMutation({
    mutationFn: ({ file, clears }: { file: LibraryFileListItem; clears: boolean }) =>
      sendMaintenanceJob(printer.id, file.id, clears),
    onSuccess: (_data, { file, clears }) => {
      rememberClearsPlate(file.id, clears);
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      showToast(
        t('hyyz17200.maintenance.sent', { file: file.print_name || file.filename, name: printer.name }),
        'success',
      );
      onClose();
    },
    onError: (error: Error) => {
      const code = error instanceof Hyyz17200RequestError ? error.detail : undefined;
      showToast(
        code && KNOWN_ERRORS.has(code)
          ? t(`hyyz17200.maintenance.errors.${code}`, { name: printer.name })
          : t('hyyz17200.maintenance.errors.generic', { error: code || error.message }),
        'error',
      );
    },
  });
  const sending = mutation.isPending;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sending, onClose]);

  const choose = (file: LibraryFileListItem) => {
    setSelected(file);
    setClearsPlate(rememberedClearsPlate(file.id));
  };

  const loading = settingsLoading || (folderId !== null && filesLoading);

  let body;
  if (loading) {
    body = (
      <div className="flex justify-center py-6">
        <Loader2 className="w-6 h-6 animate-spin text-bambu-gray" />
      </div>
    );
  } else if (folderId === null) {
    body = (
      <p className="text-sm text-bambu-gray">
        {t('hyyz17200.maintenance.noFolder')}{' '}
        <Link to="/hyyz17200/settings?tab=maintenance" className="text-bambu-green hover:underline" onClick={onClose}>
          {t('hyyz17200.maintenance.openSettings')}
        </Link>
      </p>
    );
  } else if (offered.length === 0) {
    body = <p className="text-sm text-bambu-gray">{t('hyyz17200.maintenance.empty')}</p>;
  } else {
    body = (
      <ul className="flex flex-col gap-2">
        {offered.map((file) => {
          const isSelected = selected?.id === file.id;
          const path = file.folder_id !== null ? paths.get(file.folder_id) : undefined;
          return (
            <li key={file.id}>
              <button
                type="button"
                disabled={sending}
                aria-pressed={isSelected}
                onClick={() => choose(file)}
                className={`w-full px-3 py-2 rounded-lg border text-left flex items-center gap-3 transition-colors disabled:cursor-not-allowed ${
                  isSelected
                    ? 'border-bambu-green bg-bambu-green/10'
                    : 'border-bambu-dark-tertiary bg-bambu-dark-secondary hover:border-bambu-green hover:bg-bambu-dark-tertiary'
                }`}
              >
                {file.thumbnail_path ? (
                  <img
                    src={api.getLibraryFileThumbnailUrl(file.id)}
                    alt=""
                    className="w-10 h-10 rounded object-cover bg-bambu-dark flex-shrink-0"
                  />
                ) : (
                  <span className="w-10 h-10 rounded bg-bambu-dark flex items-center justify-center flex-shrink-0">
                    <FileBox className="w-5 h-5 text-bambu-gray" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-white truncate">{file.print_name || file.filename}</span>
                  <span className="block text-xs text-bambu-gray truncate">
                    {[path, file.print_time_seconds ? formatDuration(file.print_time_seconds) : null]
                      .filter(Boolean)
                      .join(' · ') || file.filename}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={sending ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hyyz17200-maintenance-title"
        className="w-full max-w-xl max-h-[90vh] flex flex-col bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 p-4 border-b border-bambu-dark-tertiary">
          <div className="min-w-0">
            <h2 id="hyyz17200-maintenance-title" className="text-lg font-semibold text-white truncate">
              {t('hyyz17200.maintenance.title', { name: printer.name })}
            </h2>
            <p className="text-sm text-bambu-gray">{t('hyyz17200.maintenance.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            aria-label={t('common.cancel')}
            className="p-2 -m-1 rounded-lg text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {body}
          {otherModels > 0 && (
            <p className="mt-3 text-xs text-bambu-gray">
              {t('hyyz17200.maintenance.otherModels', { count: otherModels })}
            </p>
          )}
        </div>

        {selected && (
          <div className="p-4 border-t border-bambu-dark-tertiary flex flex-col gap-3">
            <label className="flex items-start gap-2 text-sm text-white cursor-pointer">
              <input
                type="checkbox"
                checked={clearsPlate}
                disabled={sending}
                onChange={(e) => setClearsPlate(e.target.checked)}
                className="mt-0.5 accent-bambu-green"
              />
              <span>
                <span className="block">{t('hyyz17200.maintenance.clearsPlate')}</span>
                <span className="block text-xs text-bambu-gray">{t('hyyz17200.maintenance.clearsPlateHint')}</span>
              </span>
            </label>
            <button
              type="button"
              onClick={() => mutation.mutate({ file: selected, clears: clearsPlate })}
              disabled={sending}
              className="self-end px-4 py-2 text-sm rounded-lg bg-bambu-green text-white hover:bg-bambu-green/80 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {t('hyyz17200.maintenance.send')}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
