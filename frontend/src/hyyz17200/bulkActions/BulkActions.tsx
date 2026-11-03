import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CircleDot, Download, Hand, MapPin, RotateCw, Wrench } from 'lucide-react';
import { api } from '../../api/client';
import type { Printer, PrinterMaintenanceOverview, PrinterStatus } from '../../api/client';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { ACTIVE_PRINT_STATES } from '../../utils/printer';
import { INTAKE_STOPS_QUERY_KEY, listIntakeStops, setPrinterIntake } from '../printerIntakeApi';
import { BulkExternalSpool } from './BulkExternalSpool';
import { ChoiceDialog } from './ChoiceDialog';
import { MoveLocationDialog } from './MoveLocationDialog';
import { csvFilename, downloadCsv, printerInfoTable, toCsv } from './printerCsv';
import { runBatch, type BatchResult } from './runBatch';
import { byName, summarize } from './batchText';
import { PrinterNameList } from './PrinterNameList';

type Dialog = 'move' | 'maintenance' | 'intake' | 'refresh' | 'spool';

interface Props {
  selectedIds: Set<number>;
  printers: Printer[];
  /** An upstream bulk action is running. */
  disabled: boolean;
}

/** The fork's buttons on the printers page's multi-select toolbar. */
export function Hyyz17200BulkActions({ selectedIds, printers, disabled }: Props) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [running, setRunning] = useState(false);

  const { data: intakeStops } = useQuery({ queryKey: INTAKE_STOPS_QUERY_KEY, queryFn: listIntakeStops });
  const stopped = new Set(intakeStops?.map((s) => s.printer_id));

  const selected = byName(printers.filter((p) => selectedIds.has(p.id)));
  const statusOf = (id: number) => queryClient.getQueryData<PrinterStatus>(['printerStatus', id]);
  const canUpdate = hasPermission('printers:update');
  const canControl = hasPermission('printers:control');
  const busy = disabled || running || !selected.length;

  const inMaintenance = selected.filter((p) => p.is_active === false);
  const inService = selected.filter((p) => p.is_active !== false);
  const printingInService = inService.filter((p) => ACTIVE_PRINT_STATES.includes(statusOf(p.id)?.state ?? ''));
  const refreshable = selected.filter((p) => p.is_active !== false && statusOf(p.id)?.connected);

  const finish = (action: string, done: BatchResult<Printer, unknown>) => {
    const { message, type } = summarize(t, done, action);
    showToast(message, type);
    setRunning(false);
    setDialog(null);
  };

  const run = async (action: string, targets: Printer[], task: (p: Printer) => Promise<unknown>, after: () => void) => {
    setRunning(true);
    const done = await runBatch(targets, task);
    after();
    finish(action, done);
  };

  const setMaintenance = (enter: boolean, targets: Printer[]) =>
    run(
      t(enter ? 'printers.maintenance.menuEnter' : 'printers.maintenance.menuExit'),
      targets,
      (p) => api.updatePrinter(p.id, { is_active: !enter }),
      () => {
        queryClient.invalidateQueries({ queryKey: ['printers'] });
        targets.forEach((p) => queryClient.invalidateQueries({ queryKey: ['printerStatus', p.id] }));
      },
    );

  const setIntake = (stop: boolean, targets: Printer[]) =>
    run(
      t(stop ? 'hyyz17200.printerIntake.menuStop' : 'hyyz17200.printerIntake.menuResume'),
      targets,
      (p) => setPrinterIntake(p.id, stop),
      () => queryClient.invalidateQueries({ queryKey: INTAKE_STOPS_QUERY_KEY }),
    );

  const refresh = () =>
    run(
      t('printers.forceRefresh'),
      refreshable,
      (p) => api.refreshPrinterStatus(p.id),
      () => refreshable.forEach((p) => queryClient.invalidateQueries({ queryKey: ['printerStatus', p.id] })),
    );

  const move = async (location: string | null) => {
    setRunning(true);
    try {
      const { moved } = await api.assignPrinterLocation(selected.map((p) => p.id), location);
      showToast(t('printers.locations.moved', { count: moved }));
      setDialog(null);
    } catch (error) {
      showToast(t('printers.locations.failed', { error: error instanceof Error ? error.message : String(error) }), 'error');
    } finally {
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      queryClient.invalidateQueries({ queryKey: ['printer-locations'] });
      setRunning(false);
    }
  };

  const exportCsv = () => {
    const hours = new Map(
      queryClient
        .getQueryData<PrinterMaintenanceOverview[]>(['maintenanceOverview'])
        ?.map((o) => [o.printer_id, o.total_print_hours]) ?? [],
    );
    downloadCsv(csvFilename(), toCsv(printerInfoTable(selected, statusOf, (id) => hours.get(id), t)));
    showToast(t('hyyz17200.bulk.csv.exported', { count: selected.length }));
  };

  const noEdit = canUpdate ? undefined : t('printers.permission.noEdit');

  return (
    <>
      <div className="w-px h-6 bg-bambu-dark-tertiary" />

      <Button variant="secondary" size="sm" onClick={() => setDialog('move')} disabled={busy || !canUpdate} title={noEdit}>
        <MapPin className="w-3.5 h-3.5" />
        {t('hyyz17200.bulk.move.button')}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setDialog('maintenance')} disabled={busy || !canUpdate} title={noEdit}>
        <Wrench className="w-3.5 h-3.5" />
        {t('hyyz17200.bulk.maintenance.button')}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setDialog('intake')} disabled={busy || !canUpdate} title={noEdit}>
        <Hand className="w-3.5 h-3.5" />
        {t('hyyz17200.bulk.intake.button')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setDialog('refresh')}
        disabled={busy || !refreshable.length}
        title={!refreshable.length ? t('printers.bulk.noneApplicable') : undefined}
      >
        <RotateCw className="w-3.5 h-3.5" />
        {t('printers.forceRefresh')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setDialog('spool')}
        disabled={busy || !canControl}
        title={canControl ? undefined : t('printers.permission.noControl')}
      >
        <CircleDot className="w-3.5 h-3.5" />
        {t('hyyz17200.bulk.spool.button')}
      </Button>
      <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!selected.length}>
        <Download className="w-3.5 h-3.5" />
        {t('hyyz17200.bulk.csv.button')}
      </Button>

      {dialog === 'move' && (
        <MoveLocationDialog printers={selected} saving={running} onMove={move} onCancel={() => setDialog(null)} />
      )}

      {dialog === 'maintenance' && (
        <ChoiceDialog
          title={t('hyyz17200.bulk.maintenance.title', { count: selected.length })}
          selectedCount={selected.length}
          running={running}
          choices={[
            {
              key: 'enter',
              label: t('printers.maintenance.menuEnter'),
              description: t('hyyz17200.bulk.maintenance.enterDescription'),
              printers: inService,
              warning: printingInService.length
                ? t('hyyz17200.bulk.maintenance.enterPrinting', { names: printingInService.map((p) => p.name).join(', ') })
                : undefined,
            },
            {
              key: 'exit',
              label: t('printers.maintenance.menuExit'),
              description: t('hyyz17200.bulk.maintenance.exitDescription'),
              printers: inMaintenance,
            },
          ]}
          onConfirm={(key, targets) => setMaintenance(key === 'enter', targets)}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog === 'intake' && (
        <ChoiceDialog
          title={t('hyyz17200.bulk.intake.title', { count: selected.length })}
          selectedCount={selected.length}
          running={running}
          choices={[
            {
              key: 'stop',
              label: t('hyyz17200.printerIntake.menuStop'),
              description: t('hyyz17200.bulk.intake.stopDescription'),
              printers: selected.filter((p) => !stopped.has(p.id)),
            },
            {
              key: 'resume',
              label: t('hyyz17200.printerIntake.menuResume'),
              description: t('hyyz17200.bulk.intake.resumeDescription'),
              printers: selected.filter((p) => stopped.has(p.id)),
            },
          ]}
          onConfirm={(key, targets) => setIntake(key === 'stop', targets)}
          onCancel={() => setDialog(null)}
        />
      )}

      {dialog === 'refresh' && (
        <ConfirmModal
          title={t('hyyz17200.bulk.refresh.title', { count: refreshable.length })}
          message={t('hyyz17200.bulk.refresh.message')}
          confirmText={t('printers.forceRefresh')}
          isLoading={running}
          onConfirm={refresh}
          onCancel={() => setDialog(null)}
        >
          <PrinterNameList printers={refreshable} />
          {selected.length > refreshable.length && (
            <p className="mt-2 text-xs text-bambu-gray">
              {t('hyyz17200.bulk.refresh.skippedOffline', { count: selected.length - refreshable.length })}
            </p>
          )}
        </ConfirmModal>
      )}

      {dialog === 'spool' && <BulkExternalSpool printers={selected} onClose={() => setDialog(null)} />}
    </>
  );
}
