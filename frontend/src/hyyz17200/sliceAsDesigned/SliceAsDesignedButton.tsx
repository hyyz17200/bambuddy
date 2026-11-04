import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, Wand2 } from 'lucide-react';
import { Button } from '../../components/Button';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { ModalShell } from '../calibration/ModalShell';
import { Hyyz17200RequestError } from '../request';
import { isProjectThreeMf, SLICE_BATCHES_QUERY_KEY, startSliceBatch } from './api';

const K = 'hyyz17200.sliceAsDesigned';

interface FileLike {
  id: number;
  filename: string;
  file_type?: string | null;
}

interface Props {
  /** The ticked file ids, in the order they were ticked. */
  selected: number[];
  /** Every file the page can resolve a ticked id to. */
  files: Map<number, FileLike>;
}

/** File manager toolbar: slice the ticked 3MF projects with their own settings.
 *  FileManagerPage.tsx mounts it with one line. */
export function SliceAsDesignedButton({ selected, files }: Props) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const projects = useMemo(
    () => selected.map((id) => files.get(id)).filter((f): f is FileLike => !!f && isProjectThreeMf(f)),
    [selected, files],
  );
  const leftOut = selected.length - projects.length;

  const start = useMutation({
    mutationFn: () => startSliceBatch(projects.map((f) => f.id)),
    onSuccess: () => {
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: SLICE_BATCHES_QUERY_KEY });
    },
    onError: (error) => {
      const detail = error instanceof Hyyz17200RequestError ? error.detail ?? error.message : String(error);
      showToast(t(`${K}.startFailed`, { detail }), 'error');
    },
  });

  if (projects.length === 0) return null;
  const allowed = hasPermission('library:upload');

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={!allowed}
        title={allowed ? t(`${K}.buttonTitle`) : t(`${K}.noPermission`)}
      >
        <Wand2 className="w-4 h-4 sm:mr-1" />
        <span className="hidden sm:inline">{t(`${K}.button`, { count: projects.length })}</span>
      </Button>
      {open && (
        <ModalShell
          title={t(`${K}.dialogTitle`)}
          onClose={() => setOpen(false)}
          busy={start.isPending}
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={start.isPending}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
                {start.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                {t(`${K}.start`, { count: projects.length })}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm text-bambu-gray">
            <p>{t(`${K}.dialogIntro`)}</p>
            <p>{t(`${K}.dialogMultiPlate`)}</p>
            {leftOut > 0 && <p className="text-amber-400">{t(`${K}.dialogLeftOut`, { count: leftOut })}</p>}
            <div>
              <p className="mb-1 text-white">{t(`${K}.dialogFiles`, { count: projects.length })}</p>
              <ul className="max-h-60 overflow-y-auto rounded border border-bambu-dark-tertiary px-3 py-2">
                {projects.map((f) => (
                  <li key={f.id} className="truncate" title={f.filename}>
                    {f.filename}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  );
}
