import type { api as upstreamApi, KProfile, Printer, PrinterStatus } from '../../api/client';
import { resolveSlotNozzleDiameter } from '../../utils/amsHelpers';
import { mapModelCode } from '../../utils/printerModel';

/** The external spool holder's AMS id. A single-nozzle printer has one, tray 0. */
export const EXT_AMS_ID = 255;
export const EXT_TRAY_ID = 0;

type Api = typeof upstreamApi;
export type SlotConfig = Parameters<Api['configureAmsSlot']>[3];
export type SlotResult = Awaited<ReturnType<Api['configureAmsSlot']>>;
export type SlotWrites = Pick<Api, 'configureAmsSlot' | 'saveSlotPreset' | 'resetAmsSlot'>;

type SpoolStatus = Pick<PrinterStatus, 'connected' | 'vt_tray' | 'nozzles' | 'ams_extruder_map'> & {
  state?: string | null;
};

export type SkipReason = 'offline' | 'dualNozzle';

export interface SpoolTargets {
  /** Printers that can be configured, grouped by model in selection order. */
  byModel: Map<string, Printer[]>;
  skipped: { printer: Printer; reason: SkipReason }[];
}

/** Which selected printers can take the batch. The batch writes tray 0, so a
 *  printer with two holders (H2D, H2C) is left out rather than guessed at. */
export function externalSpoolTargets(
  printers: Printer[],
  statusOf: (id: number) => SpoolStatus | undefined,
): SpoolTargets {
  const byModel = new Map<string, Printer[]>();
  const skipped: SpoolTargets['skipped'] = [];
  for (const printer of printers) {
    const status = statusOf(printer.id);
    if (printer.is_active === false || !status?.connected) {
      skipped.push({ printer, reason: 'offline' });
    } else if (printer.nozzle_count === 2 || (status.vt_tray?.length ?? 0) > 1) {
      skipped.push({ printer, reason: 'dualNozzle' });
    } else {
      const model = mapModelCode(printer.model) || printer.model || '?';
      byModel.set(model, [...(byModel.get(model) ?? []), printer]);
    }
  }
  return { byModel, skipped };
}

export function extNozzleDiameter(status: SpoolStatus | undefined): string | undefined {
  return resolveSlotNozzleDiameter(status, EXT_AMS_ID);
}

/**
 * The slot settings for one printer of the batch.
 *
 * The dialog picked a K profile from the template printer's table, and a
 * `cali_idx` only means something on the printer it came from. Every other
 * printer gets its own profile with the same name and filament, or the default
 * K when it has none. `kDefaulted` reports the second case.
 */
export function configForPrinter(
  config: SlotConfig,
  isTemplate: boolean,
  nozzleDiameter: string | undefined,
  templateProfile: KProfile | undefined,
  ownProfiles: KProfile[] | undefined,
): { config: SlotConfig; kDefaulted: boolean } {
  const withNozzle = { ...config, nozzle_diameter: nozzleDiameter ?? config.nozzle_diameter };
  if (isTemplate || config.cali_idx < 0) return { config: withNozzle, kDefaulted: false };
  const match = templateProfile
    ? ownProfiles?.find(
        (p) => p.name === templateProfile.name && p.filament_id === templateProfile.filament_id,
      )
    : undefined;
  if (!match) {
    return {
      config: {
        ...withNozzle,
        cali_idx: -1,
        k_value: 0,
        kprofile_filament_id: undefined,
        kprofile_setting_id: undefined,
      },
      kDefaulted: true,
    };
  }
  const k = parseFloat(match.k_value);
  return {
    config: {
      ...withNozzle,
      cali_idx: match.slot_id,
      k_value: Number.isFinite(k) ? k : 0,
      kprofile_filament_id: match.filament_id,
      kprofile_setting_id: match.setting_id || undefined,
    },
    kDefaulted: false,
  };
}

export interface SlotWriteHandlers {
  configure: (config: SlotConfig) => Promise<SlotResult>;
  savePreset: (
    presetId: string,
    presetName: string,
    presetSource: string | undefined,
  ) => Promise<Awaited<ReturnType<Api['saveSlotPreset']>>>;
  reset: () => Promise<Awaited<ReturnType<Api['resetAmsSlot']>>>;
}

/**
 * Routes the slot dialog's writes for the template's external spool to
 * `handlers`, so one dialog configures the whole batch. Every other call goes
 * through untouched. Returns the function that puts the originals back.
 *
 * The dialog is upstream's and calls `api` directly; this is the only way in
 * without editing it. `externalSpool.test.tsx` renders the real dialog against
 * this, so a renamed or reshaped call fails there rather than silently writing
 * to one printer.
 */
export function interceptSlotWrites(
  target: SlotWrites,
  templateId: number,
  handlers: SlotWriteHandlers,
): () => void {
  const original: SlotWrites = {
    configureAmsSlot: target.configureAmsSlot,
    saveSlotPreset: target.saveSlotPreset,
    resetAmsSlot: target.resetAmsSlot,
  };
  const ours = (printerId: number, amsId: number, trayId: number) =>
    printerId === templateId && amsId === EXT_AMS_ID && trayId === EXT_TRAY_ID;

  const configureAmsSlot: Api['configureAmsSlot'] = (printerId, amsId, trayId, config) =>
    ours(printerId, amsId, trayId)
      ? handlers.configure(config)
      : original.configureAmsSlot(printerId, amsId, trayId, config);
  const saveSlotPreset: Api['saveSlotPreset'] = (printerId, amsId, trayId, presetId, presetName, presetSource, trayInfoIdx) =>
    ours(printerId, amsId, trayId)
      ? handlers.savePreset(presetId, presetName, presetSource)
      : original.saveSlotPreset(printerId, amsId, trayId, presetId, presetName, presetSource, trayInfoIdx);
  const resetAmsSlot: Api['resetAmsSlot'] = (printerId, amsId, trayId) =>
    ours(printerId, amsId, trayId) ? handlers.reset() : original.resetAmsSlot(printerId, amsId, trayId);

  Object.assign(target, { configureAmsSlot, saveSlotPreset, resetAmsSlot });
  return () => {
    // Only undo our own patch; never clobber one installed after it.
    if (target.configureAmsSlot === configureAmsSlot) target.configureAmsSlot = original.configureAmsSlot;
    if (target.saveSlotPreset === saveSlotPreset) target.saveSlotPreset = original.saveSlotPreset;
    if (target.resetAmsSlot === resetAmsSlot) target.resetAmsSlot = original.resetAmsSlot;
  };
}

/** `#RRGGBB` from the `RRGGBBAA` the dialog sends. */
export function colorOf(config: SlotConfig): string {
  return `#${config.tray_color.slice(0, 6)}`;
}
