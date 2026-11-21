import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Hand } from 'lucide-react';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useCalibrationCard } from './calibration/useCalibrationCard';
import { useMaintenanceJob } from './maintenanceJob/useMaintenanceJob';
import { INTAKE_STOPS_QUERY_KEY, listIntakeStops, setPrinterIntake } from './printerIntakeApi';
import { usePrinterMove } from './printerMove';
import { usePrinterNotes } from './printerNotes/usePrinterNotes';

// Another browser may change it; this is how soon the card notices.
const REFRESH_MS = 30_000;

/** Yellow rather than the amber of an HMS warning (`bg-status-warning`), and
 *  ringed, so the S card's dot tells the two apart. */
export const INTAKE_STOPPED_PIP = 'bg-yellow-400 ring-2 ring-yellow-400/40';

const PRINT_BUTTON_STOPPED = '!bg-yellow-400 hover:!bg-yellow-300 !text-gray-900';

export interface Hyyz17200Intake {
  /** The queue sends this printer no new jobs. */
  stopped: boolean;
  /** The card menu's toggle, then "Move to location", "Send maintenance G-code"
   *  and "Notes".
   *  Closes the menu through `onMenuClose`. */
  menuItem: ReactNode;
  /** The pills for the M and larger badge row: not taking jobs, and a batch
   *  calibration's place. Nothing when neither applies. */
  pill: ReactNode;
  /** Next to the printer's name in every card size, the S card included: the
   *  notes marker. Nothing when the printer has no notes to show. */
  nameBadge: ReactNode;
  /** A one-tap toggle for the card's footer row, left of the camera button,
   *  sized by the footer's own icon-button classes. Stops at once; resuming
   *  asks first, so a stray tap on a touch screen never sends a printer that is
   *  being worked on a job. */
  footerButton: (className: string) => ReactNode;
  /** Classes for the Print button, or `undefined` for upstream's green. */
  printButtonClass: string | undefined;
  printButtonTitle: string | undefined;
  /** Runs `action` at once while taking jobs; otherwise asks to resume first. */
  guard: (action: () => void) => void;
  /** Render once in the card. */
  dialog: ReactNode;
}

/** "Stop taking jobs" on one printer card. Unlike maintenance mode the printer
 *  stays connected and every control keeps working; only the queue skips it. */
export function useHyyz17200Intake(
  printer: { id: number; name: string; location?: string | null; model?: string | null },
  onMenuClose: () => void,
): Hyyz17200Intake {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canChange = hasPermission('printers:update');
  // The open resume dialog: `then` is what the Print button was about to do.
  const [asking, setAsking] = useState<{ then?: () => void } | null>(null);

  // Rides on this hook's connection points in PrintersPage, so the batch
  // calibration needs none of its own.
  const calibration = useCalibrationCard(printer.id);
  // Likewise "Move to location" in the card menu.
  const move = usePrinterMove(printer, onMenuClose);
  // And "Send maintenance G-code".
  const maintenance = useMaintenanceJob(printer, onMenuClose);
  // And the notes, plus their marker beside the name.
  const notes = usePrinterNotes(printer, onMenuClose);

  const { data } = useQuery({
    queryKey: INTAKE_STOPS_QUERY_KEY,
    queryFn: listIntakeStops,
    refetchInterval: REFRESH_MS,
  });
  const stopped = data?.some((stop) => stop.printer_id === printer.id) ?? false;

  const mutation = useMutation({
    mutationFn: ({ stop }: { stop: boolean; then?: () => void }) => setPrinterIntake(printer.id, stop),
    onSuccess: (_data, { stop, then }) => {
      queryClient.invalidateQueries({ queryKey: INTAKE_STOPS_QUERY_KEY });
      showToast(
        t(stop ? 'hyyz17200.printerIntake.toastStopped' : 'hyyz17200.printerIntake.toastResumed', {
          name: printer.name,
        }),
        'success',
      );
      then?.();
    },
    onError: () =>
      showToast(t('hyyz17200.printerIntake.saveFailed', { name: printer.name }), 'error'),
  });

  const intakeMenuItem = (
    <button
      className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 ${
        canChange ? 'hover:bg-bambu-dark-tertiary' : 'opacity-50 cursor-not-allowed'
      }`}
      disabled={mutation.isPending || !canChange}
      onClick={() => {
        if (!canChange) return;
        onMenuClose();
        mutation.mutate({ stop: !stopped });
      }}
      title={!canChange ? t('printers.permission.noEdit') : undefined}
    >
      <Hand className="w-[var(--pc-i4,1rem)] h-[var(--pc-i4,1rem)]" />
      {t(stopped ? 'hyyz17200.printerIntake.menuResume' : 'hyyz17200.printerIntake.menuStop')}
    </button>
  );

  const menuItem = (
    <>
      {intakeMenuItem}
      {move.menuItem}
      {maintenance.menuItem}
      {notes.menuItem}
    </>
  );

  const footerButton = (className: string) => (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        if (stopped) setAsking({});
        else mutation.mutate({ stop: true });
      }}
      disabled={mutation.isPending || !canChange}
      title={
        !canChange
          ? t('printers.permission.noEdit')
          : t(stopped ? 'hyyz17200.printerIntake.footerResume' : 'hyyz17200.printerIntake.footerStop')
      }
      aria-label={t(stopped ? 'hyyz17200.printerIntake.menuResume' : 'hyyz17200.printerIntake.menuStop')}
      aria-pressed={stopped}
      className={`${className} ${stopped ? PRINT_BUTTON_STOPPED : ''}`}
    >
      <Hand className="w-[var(--pc-i4,1rem)] h-[var(--pc-i4,1rem)]" />
    </Button>
  );

  const intakePill = stopped ? (
    <button
      type="button"
      onClick={() => setAsking({})}
      className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-400 hover:bg-yellow-200 dark:hover:bg-yellow-500/30 transition-colors"
      title={t('hyyz17200.printerIntake.pillTitle')}
    >
      <Hand className="w-[var(--pc-i3,0.75rem)] h-[var(--pc-i3,0.75rem)]" />
      {t('hyyz17200.printerIntake.pill')}
    </button>
  ) : null;

  const guard = (action: () => void) => {
    if (stopped) setAsking({ then: action });
    else action();
  };

  const forPrint = asking?.then !== undefined;
  const dialog = asking ? (
    <ConfirmModal
      title={t('hyyz17200.printerIntake.dialogTitle')}
      message={
        canChange
          ? t(forPrint ? 'hyyz17200.printerIntake.dialogPrint' : 'hyyz17200.printerIntake.dialogResume', {
              name: printer.name,
            })
          : t('hyyz17200.printerIntake.dialogNoPermission', { name: printer.name })
      }
      confirmText={t(
        forPrint ? 'hyyz17200.printerIntake.confirmPrint' : 'hyyz17200.printerIntake.menuResume',
      )}
      variant="warning"
      confirmDisabled={!canChange}
      isLoading={mutation.isPending}
      onConfirm={() =>
        mutation.mutate({ stop: false, then: asking.then }, { onSettled: () => setAsking(null) })
      }
      onCancel={() => setAsking(null)}
    />
  ) : null;

  const pill =
    intakePill || calibration.pill ? (
      <>
        {intakePill}
        {calibration.pill}
      </>
    ) : null;

  return {
    stopped,
    menuItem,
    pill,
    nameBadge: notes.badge,
    footerButton,
    printButtonClass: stopped ? PRINT_BUTTON_STOPPED : undefined,
    printButtonTitle: stopped ? t('hyyz17200.printerIntake.printButtonTitle') : undefined,
    guard,
    dialog: (
      <>
        {dialog}
        {calibration.dialog}
        {move.dialog}
        {maintenance.dialog}
        {notes.dialog}
      </>
    ),
  };
}
