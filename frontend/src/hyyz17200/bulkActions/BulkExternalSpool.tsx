import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { KProfile, Printer, PrinterStatus } from '../../api/client';
import { ConfigureAmsSlotModal } from '../../components/ConfigureAmsSlotModal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useToast } from '../../contexts/ToastContext';
import { ACTIVE_PRINT_STATES } from '../../utils/printer';
import {
  EXT_AMS_ID,
  EXT_TRAY_ID,
  colorOf,
  configForPrinter,
  extNozzleDiameter,
  externalSpoolTargets,
  interceptSlotWrites,
  type SlotConfig,
  type SlotResult,
  type SlotWrites,
} from './externalSpool';
import { runBatch } from './runBatch';
import { summarize } from './batchText';
import { PrinterNameList } from './PrinterNameList';

type Pending =
  | { kind: 'configure'; config: SlotConfig; resolve: (r: SlotResult) => void; reject: (e: Error) => void }
  | { kind: 'reset'; resolve: (r: { success: boolean; message: string }) => void; reject: (e: Error) => void };

interface Props {
  /** The selected printers, in the order they are listed. */
  printers: Printer[];
  onClose: () => void;
}

/**
 * Upstream's slot dialog, opened on the first selected printer of one model,
 * whose writes go to every selected printer of that model after a confirm.
 */
export function BulkExternalSpool({ printers, onClose }: Props) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const statusOf = (id: number) => queryClient.getQueryData<PrinterStatus>(['printerStatus', id]);

  // Fixed for the dialog's life: a status update must not move printers in or out mid-way.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const targets = useMemo(() => externalSpoolTargets(printers, statusOf), []);
  const models = [...targets.byModel.keys()];
  const [model, setModel] = useState<string | null>(models.length === 1 ? models[0] : null);
  // The chooser's selection when several models are selected: the largest group first.
  const [pick, setPick] = useState(
    () => [...targets.byModel].sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? '',
  );
  const group = useMemo(() => (model ? targets.byModel.get(model) ?? [] : []), [model, targets]);
  const template = group[0];
  const [pending, setPending] = useState<Pending | null>(null);
  const [running, setRunning] = useState(false);
  const original = useRef<SlotWrites | null>(null);
  // Printers whose slot was configured, with the filament id each was given.
  const configured = useRef<{ printer: Printer; trayInfoIdx?: string }[]>([]);

  useEffect(() => {
    if (!template) return;
    original.current = {
      configureAmsSlot: api.configureAmsSlot,
      saveSlotPreset: api.saveSlotPreset,
      resetAmsSlot: api.resetAmsSlot,
    };
    return interceptSlotWrites(api, template.id, {
      configure: (config) => new Promise((resolve, reject) => setPending({ kind: 'configure', config, resolve, reject })),
      reset: () => new Promise((resolve, reject) => setPending({ kind: 'reset', resolve, reject })),
      savePreset: async (presetId, presetName, presetSource) => {
        const writes = original.current!;
        const done = await runBatch(configured.current, ({ printer, trayInfoIdx }) =>
          writes.saveSlotPreset(printer.id, EXT_AMS_ID, EXT_TRAY_ID, presetId, presetName, presetSource, trayInfoIdx),
        );
        for (const { printer, error } of done.failed) {
          console.warn(`Failed to save slot preset mapping for ${printer.printer.name}:`, error);
        }
        if (!done.ok.length) throw new Error('No slot preset mapping saved');
        return done.ok[0].result;
      },
    });
  }, [template]);

  // A pending write left behind (dialog closed some other way) must not hang the dialog's mutation.
  useEffect(() => () => pending?.reject(new Error(t('hyyz17200.bulk.spool.cancelled'))), [pending, t]);

  const kProfiles = (printerId: number, nozzleDiameter: string | undefined) =>
    queryClient
      .fetchQuery({
        queryKey: ['kprofiles', printerId, nozzleDiameter],
        queryFn: () => api.getKProfiles(printerId, nozzleDiameter),
      })
      .then((r) => r.profiles);

  const applyConfigure = async (config: SlotConfig): Promise<SlotResult> => {
    const writes = original.current!;
    const templateProfile =
      config.cali_idx >= 0
        ? (await kProfiles(template.id, extNozzleDiameter(statusOf(template.id))).catch(() => [] as KProfile[])).find(
            (p) => p.slot_id === config.cali_idx,
          )
        : undefined;
    const done = await runBatch(group, async (printer) => {
      const isTemplate = printer.id === template.id;
      const nozzle = extNozzleDiameter(statusOf(printer.id));
      const own = !isTemplate && templateProfile ? await kProfiles(printer.id, nozzle).catch(() => undefined) : undefined;
      const { config: ownConfig, kDefaulted } = configForPrinter(config, isTemplate, nozzle, templateProfile, own);
      const result = await writes.configureAmsSlot(printer.id, EXT_AMS_ID, EXT_TRAY_ID, ownConfig);
      return { result, kDefaulted };
    });
    configured.current = done.ok.map(({ printer, result }) => ({ printer, trayInfoIdx: result.result.tray_info_idx }));
    report(t('hyyz17200.bulk.spool.configureAction'), done);
    const defaulted = done.ok.filter((r) => r.result.kDefaulted).map((r) => r.printer.name);
    if (defaulted.length) showToast(t('hyyz17200.bulk.spool.kDefaulted', { names: defaulted.join(', ') }), 'warning');
    if (!done.ok.length) throw new Error(t('hyyz17200.bulk.spool.allFailed'));
    return (done.ok.find((r) => r.printer.id === template.id) ?? done.ok[0]).result.result;
  };

  const printingNow = group.filter((p) => ACTIVE_PRINT_STATES.includes(statusOf(p.id)?.state ?? ''));

  const applyReset = async () => {
    const writes = original.current!;
    const idle = group.filter((p) => !printingNow.includes(p));
    const done = await runBatch(idle, (printer) => writes.resetAmsSlot(printer.id, EXT_AMS_ID, EXT_TRAY_ID));
    report(t('hyyz17200.bulk.spool.resetAction'), done);
    if (!done.ok.length) throw new Error(t('hyyz17200.bulk.spool.allFailed'));
    return done.ok[0].result;
  };

  const report = (action: string, done: Parameters<typeof summarize>[1]) => {
    const { message, type } = summarize(t, done, action);
    showToast(message, type);
  };

  const confirm = async () => {
    if (!pending) return;
    setRunning(true);
    try {
      if (pending.kind === 'configure') pending.resolve(await applyConfigure(pending.config));
      else pending.resolve(await applyReset());
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setRunning(false);
      setPending(null);
    }
  };

  const cancel = () => {
    pending?.reject(new Error(t('hyyz17200.bulk.spool.cancelled')));
    setPending(null);
  };

  const skippedNotes = (['offline', 'dualNozzle'] as const)
    .map((reason) => {
      const names = targets.skipped.filter((s) => s.reason === reason).map((s) => s.printer.name);
      return names.length ? t(`hyyz17200.bulk.spool.skipped.${reason}`, { names: names.join(', ') }) : null;
    })
    .filter((note): note is string => !!note);

  if (!models.length) {
    return (
      <ConfirmModal
        title={t('hyyz17200.bulk.spool.noneTitle')}
        message={skippedNotes.join('\n')}
        confirmText={t('common.close', 'Close')}
        onConfirm={onClose}
        onCancel={onClose}
      />
    );
  }

  if (!model) {
    return (
      <ConfirmModal
        title={t('hyyz17200.bulk.spool.chooseModelTitle')}
        message={t('hyyz17200.bulk.spool.chooseModelMessage')}
        confirmText={t('hyyz17200.bulk.spool.next')}
        onConfirm={() => setModel(pick)}
        onCancel={onClose}
      >
        <div role="radiogroup" className="flex flex-col gap-2">
          {models.map((m) => (
            <label
              key={m}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm text-white ${
                m === pick ? 'border-bambu-green bg-bambu-green/10' : 'border-bambu-dark-tertiary hover:bg-bambu-dark-tertiary'
              }`}
            >
              <input
                type="radio"
                name="hyyz17200-spool-model"
                className="accent-bambu-green"
                checked={m === pick}
                onChange={() => setPick(m)}
              />
              {t('hyyz17200.bulk.spool.modelOption', { model: m, count: targets.byModel.get(m)!.length })}
            </label>
          ))}
          {skippedNotes.map((note) => (
            <p key={note} className="text-xs text-bambu-gray">{note}</p>
          ))}
        </div>
      </ConfirmModal>
    );
  }

  const otherModels = models.filter((m) => m !== model).flatMap((m) => targets.byModel.get(m)!.map((p) => p.name));
  const notes = [
    ...skippedNotes,
    ...(otherModels.length ? [t('hyyz17200.bulk.spool.skipped.otherModel', { names: otherModels.join(', ') })] : []),
  ];

  return (
    <>
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[55] max-w-[90vw] rounded-lg border border-bambu-green/50 bg-bambu-dark-secondary px-4 py-2 text-sm text-white shadow-xl pointer-events-none">
        <div className="font-medium">
          {t('hyyz17200.bulk.spool.bannerTitle', { count: group.length, model })}
        </div>
        <div className="text-xs text-bambu-gray">{t('hyyz17200.bulk.spool.bannerTemplate', { name: template.name })}</div>
      </div>
      <ConfigureAmsSlotModal
        isOpen
        onClose={onClose}
        printerId={template.id}
        slotInfo={{ amsId: EXT_AMS_ID, trayId: EXT_TRAY_ID }}
        printerModel={model}
        nozzleDiameter={extNozzleDiameter(statusOf(template.id))}
        // Printing printers are skipped one by one on reset, not refused all together.
        printerState={undefined}
        onSuccess={() => {
          for (const p of group) {
            queryClient.invalidateQueries({ queryKey: ['slotPresets', p.id] });
            queryClient.invalidateQueries({ queryKey: ['printerStatus', p.id] });
          }
        }}
      />
      {pending && (
        <ConfirmModal
          overlayZIndex="z-[60]"
          variant="warning"
          title={t(
            pending.kind === 'configure' ? 'hyyz17200.bulk.spool.confirmConfigureTitle' : 'hyyz17200.bulk.spool.confirmResetTitle',
            { count: pending.kind === 'reset' ? group.length - printingNow.length : group.length },
          )}
          message={
            pending.kind === 'configure'
              ? t('hyyz17200.bulk.spool.confirmConfigureMessage', {
                  name: pending.config.tray_sub_brands,
                  color: colorOf(pending.config),
                })
              : t('hyyz17200.bulk.spool.confirmResetMessage')
          }
          confirmText={t('hyyz17200.bulk.spool.apply')}
          confirmDisabled={pending.kind === 'reset' && printingNow.length === group.length}
          isLoading={running}
          onConfirm={confirm}
          onCancel={cancel}
        >
          <PrinterNameList printers={pending.kind === 'reset' ? group.filter((p) => !printingNow.includes(p)) : group} />
          {pending.kind === 'reset' && printingNow.length > 0 && (
            <p className="mt-2 text-xs text-yellow-400">
              {t('hyyz17200.bulk.spool.resetPrintingSkipped', { names: printingNow.map((p) => p.name).join(', ') })}
            </p>
          )}
          {notes.map((note) => (
            <p key={note} className="mt-2 text-xs text-bambu-gray">{note}</p>
          ))}
        </ConfirmModal>
      )}
    </>
  );
}
