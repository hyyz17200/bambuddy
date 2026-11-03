/**
 * The fork's buttons on the printers page's multi-select toolbar (hyyz17200):
 * move to a location, maintenance and taking jobs (one dialog each, where the
 * choice is the confirmation), force refresh, CSV export, and the external
 * spool set on every selected printer through upstream's own slot dialog.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { KProfile, Printer } from '../../api/client';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      updatePrinter: vi.fn(),
      refreshPrinterStatus: vi.fn(),
      assignPrinterLocation: vi.fn(),
      getPrinterLocations: vi.fn(),
      // Upstream's slot dialog.
      getCloudSettings: vi.fn(),
      getKProfiles: vi.fn(),
      configureAmsSlot: vi.fn(),
      getCloudSettingDetail: vi.fn(),
      saveSlotPreset: vi.fn(),
      resetAmsSlot: vi.fn(),
      getSettings: vi.fn(),
      getSlicerPrinterModels: vi.fn(),
      getLocalPresets: vi.fn(),
      getBuiltinFilaments: vi.fn(),
      orcaCloudListProfiles: vi.fn(),
      searchColors: vi.fn(),
      getColorCatalog: vi.fn(),
      getPrinterStatus: vi.fn(),
      getSlotSpoolDefaults: vi.fn(),
    },
  };
});

const intake = vi.hoisted(() => ({ stopped: [] as number[], set: vi.fn() }));
vi.mock('../../hyyz17200/printerIntakeApi', () => ({
  INTAKE_STOPS_QUERY_KEY: ['hyyz17200', 'intake-stops'],
  listIntakeStops: vi.fn(async () => intake.stopped.map((printer_id) => ({ printer_id, stopped_at: null, stopped_by: null }))),
  setPrinterIntake: intake.set,
}));

const permissions = { granted: [] as string[] };
vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({ hasPermission: (p: string) => permissions.granted.includes(p) }),
  };
});

import { api } from '../../api/client';
import { ToastProvider } from '../../contexts/ToastContext';
import { Hyyz17200BulkActions } from '../../hyyz17200/bulkActions/BulkActions';
import { configForPrinter, externalSpoolTargets, type SlotConfig } from '../../hyyz17200/bulkActions/externalSpool';
import { printerInfoTable, toCsv } from '../../hyyz17200/bulkActions/printerCsv';
import { runBatch } from '../../hyyz17200/bulkActions/runBatch';
import i18n from '../../i18n';

const tr = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const t = ((key: string) => key) as never;

const printer = (id: number, extra: Partial<Printer> = {}) =>
  ({
    id,
    name: `P${id}`,
    model: 'A1',
    nozzle_count: 1,
    is_active: true,
    auto_archive: true,
    ip_address: `10.0.0.${id}`,
    serial_number: `SN${id}`,
    location: null,
    created_at: '2026-01-02T03:04:05',
    ...extra,
  }) as unknown as Printer;

const idleStatus = { connected: true, state: 'IDLE', vt_tray: [{ id: 254 }], nozzles: [{ nozzle_diameter: '0.4' }], ams_extruder_map: {} };

function setup(printers: Printer[], statuses: Record<number, object>, selected = printers.map((p) => p.id)) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [id, status] of Object.entries(statuses)) qc.setQueryData(['printerStatus', Number(id)], status);
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={qc}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  render(wrap(<Hyyz17200BulkActions selectedIds={new Set(selected)} printers={printers} disabled={false} />));
  return qc;
}

const btn = (name: string | RegExp) => screen.getByRole('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
  permissions.granted = ['printers:read', 'printers:update', 'printers:control'];
  intake.stopped = [];
  intake.set.mockResolvedValue(undefined);
  Element.prototype.scrollIntoView = vi.fn();
  mocked.updatePrinter.mockResolvedValue({});
  mocked.refreshPrinterStatus.mockResolvedValue({ status: 'ok' });
  mocked.assignPrinterLocation.mockResolvedValue({ moved: 2 });
  mocked.getPrinterLocations.mockResolvedValue([{ id: 1, name: 'Shed', icon: null, color: null, printer_count: 0 }]);
  mocked.getSettings.mockResolvedValue({});
  mocked.getSlicerPrinterModels.mockResolvedValue({});
  mocked.getCloudSettings.mockResolvedValue({
    filament: [{ setting_id: 'GFSL05_09', name: 'Bambu PLA Basic @BBL A1', filament_id: 'GFL05' }],
  });
  mocked.getKProfiles.mockResolvedValue({ profiles: [] });
  mocked.getLocalPresets.mockResolvedValue({ filament: [] });
  mocked.getBuiltinFilaments.mockResolvedValue([]);
  mocked.orcaCloudListProfiles.mockResolvedValue({ filament: [], printer: [], process: [] });
  mocked.searchColors.mockResolvedValue([]);
  mocked.getColorCatalog.mockResolvedValue([]);
  mocked.getPrinterStatus.mockResolvedValue({});
  mocked.getSlotSpoolDefaults.mockResolvedValue(null);
  mocked.configureAmsSlot.mockImplementation(async (id: number) => ({ success: true, message: '', tray_info_idx: `GFL05-${id}` }));
  mocked.saveSlotPreset.mockResolvedValue({});
  mocked.resetAmsSlot.mockResolvedValue({ success: true, message: 'ok' });
});

afterEach(() => vi.useRealTimers());

describe('maintenance', () => {
  it('one dialog: picks the direction, then changes only the printers that need it', async () => {
    const user = userEvent.setup();
    setup([printer(1), printer(2, { is_active: false }), printer(3, { is_active: false })], {});
    await user.click(btn(tr('hyyz17200.bulk.maintenance.button')));
    // Opens on the direction that applies to more printers: exit (2) over enter (1).
    const exit = screen.getByRole('radio', { name: new RegExp(tr('printers.maintenance.menuExit')) });
    expect(exit).toBeChecked();
    await user.click(screen.getByRole('radio', { name: new RegExp(tr('printers.maintenance.menuEnter')) }));
    await user.click(btn(tr('hyyz17200.bulk.applyTo', { action: tr('printers.maintenance.menuEnter'), count: 1 })));
    await waitFor(() => expect(mocked.updatePrinter).toHaveBeenCalledTimes(1));
    expect(mocked.updatePrinter).toHaveBeenCalledWith(1, { is_active: false });
  });

  it('warns about printers that are printing before entering', async () => {
    const user = userEvent.setup();
    setup([printer(1), printer(2)], { 1: { connected: true, state: 'RUNNING' } });
    await user.click(btn(tr('hyyz17200.bulk.maintenance.button')));
    expect(screen.getByText(tr('hyyz17200.bulk.maintenance.enterPrinting', { names: 'P1' }))).toBeInTheDocument();
    expect(mocked.updatePrinter).not.toHaveBeenCalled();
  });

  it('cannot run with nothing to change in that direction', async () => {
    const user = userEvent.setup();
    setup([printer(1)], {});
    await user.click(btn(tr('hyyz17200.bulk.maintenance.button')));
    await user.click(screen.getByRole('radio', { name: new RegExp(tr('printers.maintenance.menuExit')) }));
    expect(btn(tr('printers.maintenance.menuExit'))).toBeDisabled();
  });

  it('needs printers:update', () => {
    permissions.granted = ['printers:read'];
    setup([printer(1)], {});
    expect(btn(tr('hyyz17200.bulk.maintenance.button'))).toBeDisabled();
    expect(btn(tr('hyyz17200.bulk.intake.button'))).toBeDisabled();
    expect(btn(tr('hyyz17200.bulk.move.button'))).toBeDisabled();
  });
});

describe('taking jobs', () => {
  it('resumes only the stopped printers', async () => {
    intake.stopped = [2];
    const user = userEvent.setup();
    setup([printer(1), printer(2)], {});
    await user.click(btn(tr('hyyz17200.bulk.intake.button')));
    await user.click(await screen.findByRole('radio', { name: new RegExp(tr('hyyz17200.printerIntake.menuResume')) }));
    const resume = tr('hyyz17200.bulk.applyTo', { action: tr('hyyz17200.printerIntake.menuResume'), count: 1 });
    await waitFor(() => expect(btn(resume)).toBeEnabled());
    await user.click(btn(resume));
    await waitFor(() => expect(intake.set).toHaveBeenCalledTimes(1));
    expect(intake.set).toHaveBeenCalledWith(2, false);
  });
});

describe('force refresh', () => {
  it('asks first, then refreshes only connected printers in service', async () => {
    const user = userEvent.setup();
    setup([printer(1), printer(2), printer(3, { is_active: false })], {
      1: { connected: true },
      2: { connected: false },
      3: { connected: true },
    });
    await user.click(btn(tr('printers.forceRefresh')));
    expect(mocked.refreshPrinterStatus).not.toHaveBeenCalled();
    const dialog = screen.getByText(tr('hyyz17200.bulk.refresh.title', { count: 1 })).closest('div.fixed') as HTMLElement;
    await user.click(within(dialog).getByRole('button', { name: tr('printers.forceRefresh') }));
    await waitFor(() => expect(mocked.refreshPrinterStatus).toHaveBeenCalledTimes(1));
    expect(mocked.refreshPrinterStatus).toHaveBeenCalledWith(1);
  });
});

describe('move to location', () => {
  it('moves every selected printer in one request, to a new location too', async () => {
    const user = userEvent.setup();
    setup([printer(1), printer(2), printer(3)], {}, [1, 3]);
    await user.click(btn(tr('hyyz17200.bulk.move.button')));
    await screen.findByRole('option', { name: 'Shed' });
    await user.selectOptions(screen.getByRole('combobox'), '__new__');
    await user.type(screen.getByRole('textbox', { name: tr('hyyz17200.bulk.move.newLocationName') }), ' Lab 2 ');
    await user.click(btn(tr('printers.locations.moveButton')));
    await waitFor(() => expect(mocked.assignPrinterLocation).toHaveBeenCalledWith([1, 3], 'Lab 2'));
  });

  it('"no location" sends null', async () => {
    const user = userEvent.setup();
    setup([printer(1)], {});
    await user.click(btn(tr('hyyz17200.bulk.move.button')));
    await user.selectOptions(screen.getByRole('combobox'), '__none__');
    await user.click(btn(tr('printers.locations.moveButton')));
    await waitFor(() => expect(mocked.assignPrinterLocation).toHaveBeenCalledWith([1], null));
  });
});

describe('CSV export', () => {
  it('has the Printer Information fields, one row per printer', () => {
    const table = printerInfoTable(
      [printer(1, { location: 'Shed', name: 'A1, "left"' })],
      () => ({ connected: true, state: 'RUNNING', wired_network: false, wifi_signal: -55, firmware_version: '01.04', developer_mode: true }),
      () => 12.34,
      t,
    );
    expect(table[0]).toHaveLength(15);
    expect(table[1]).toEqual([
      'A1, "left"', 'A1', 'printers.status.available', 'printers.status.printing', '10.0.0.1', 'SN1',
      'hyyz17200.bulk.csv.wifi printers.wifiSignal.good', '-55', '01.04', 'printers.enabled', '1',
      'printers.enabled', '12.3', 'Shed', expect.stringMatching(/^2026-01-0[12]$/),
    ]);
  });

  it('quotes, keeps numbers, and defuses formulas', () => {
    const csv = toCsv([['a,b', '-55', '=1+1', 'say "hi"']]);
    expect(csv).toBe('﻿"a,b",-55,\'=1+1,"say ""hi"""\r\n');
  });

  it('downloads the selected printers', async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => (created.push(b), 'blob:x'));
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    setup([printer(10), printer(2), printer(3)], {}, [10, 2]);
    fireEvent.click(btn(tr('hyyz17200.bulk.csv.button')));
    expect(click).toHaveBeenCalled();
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(created[0]);
    });
    // Header plus two printers, by name: P2 before P10.
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1].startsWith('P2,')).toBe(true);
    expect(lines[2].startsWith('P10,')).toBe(true);
    click.mockRestore();
  });
});

describe('external spool helpers', () => {
  it('leaves out offline and two-holder printers, and groups the rest by model', () => {
    const printers = [printer(1), printer(2, { model: 'P1S' }), printer(3), printer(4, { nozzle_count: 2 }), printer(5)];
    const statuses: Record<number, object> = { 1: idleStatus, 2: idleStatus, 3: { connected: false }, 4: idleStatus, 5: idleStatus };
    const { byModel, skipped } = externalSpoolTargets(printers, (id) => statuses[id] as never);
    expect([...byModel].map(([m, ps]) => [m, ps.map((p) => p.id)])).toEqual([['A1', [1, 5]], ['P1S', [2]]]);
    expect(skipped.map((s) => [s.printer.id, s.reason])).toEqual([[3, 'offline'], [4, 'dualNozzle']]);
  });

  const config = { cali_idx: 7, k_value: 0.02, kprofile_filament_id: 'GFL05', nozzle_diameter: '0.4' } as SlotConfig;
  const profile = (slot_id: number, name: string, k = '0.030') => ({ slot_id, name, filament_id: 'GFL05', k_value: k, setting_id: 'S' }) as KProfile;

  it('gives each printer its own K profile of the same name', () => {
    const out = configForPrinter(config, false, '0.6', profile(7, 'PLA'), [profile(2, 'PLA', '0.025')]);
    expect(out).toEqual({
      config: { ...config, nozzle_diameter: '0.6', cali_idx: 2, k_value: 0.025, kprofile_filament_id: 'GFL05', kprofile_setting_id: 'S' },
      kDefaulted: false,
    });
  });

  it('falls back to the default K when the printer has no such profile', () => {
    const out = configForPrinter(config, false, undefined, profile(7, 'PLA'), [profile(7, 'PETG')]);
    expect(out.kDefaulted).toBe(true);
    expect(out.config).toMatchObject({ cali_idx: -1, k_value: 0, kprofile_filament_id: undefined });
  });

  it('sends the template its own pick unchanged', () => {
    expect(configForPrinter(config, true, '0.4', undefined, undefined)).toEqual({ config, kDefaulted: false });
  });

  it('runs every task and keeps the order', async () => {
    const done = await runBatch([1, 2, 3, 4, 5], async (n) => {
      await new Promise((r) => setTimeout(r, (6 - n) * 2));
      if (n === 2) throw new Error('nope');
      return n * 10;
    }, 2);
    expect(done.ok.map((r) => r.result)).toEqual([10, 30, 40, 50]);
    expect(done.failed).toEqual([{ printer: 2, error: 'nope' }]);
  });
});

describe('external spool on every selected printer', () => {
  const printers = [printer(1), printer(2), printer(3)];
  const statuses = { 1: idleStatus, 2: { ...idleStatus, state: 'RUNNING' }, 3: idleStatus };
  const original = { configure: mocked.configureAmsSlot, save: mocked.saveSlotPreset, reset: mocked.resetAmsSlot };

  async function openDialog() {
    const user = userEvent.setup();
    setup(printers, statuses);
    await user.click(btn(tr('hyyz17200.bulk.spool.button')));
    expect(await screen.findByText(tr('hyyz17200.bulk.spool.bannerTitle', { count: 3, model: 'A1' }))).toBeInTheDocument();
    return user;
  }

  it('configures through upstream\'s dialog, after a confirm, on every printer', async () => {
    const user = await openDialog();
    fireEvent.click(await screen.findByText('Bambu PLA Basic @BBL A1'));
    await waitFor(() => expect(btn(/Configure Slot/i)).toBeEnabled());
    fireEvent.click(btn(/Configure Slot/i));

    const confirm = await screen.findByText(tr('hyyz17200.bulk.spool.confirmConfigureTitle', { count: 3 }));
    expect(original.configure).not.toHaveBeenCalled();
    await user.click(within(confirm.closest('div.fixed') as HTMLElement).getByRole('button', { name: tr('hyyz17200.bulk.spool.apply') }));

    await waitFor(() => expect(original.save).toHaveBeenCalledTimes(3));
    expect(original.configure.mock.calls.map((c) => c.slice(0, 3))).toEqual([[1, 255, 0], [2, 255, 0], [3, 255, 0]]);
    expect(original.configure.mock.calls[2][3]).toMatchObject({ tray_info_idx: 'GFL05', tray_type: 'PLA' });
    // Each printer's mapping carries the filament id that printer was given.
    expect(original.save.mock.calls.map((c) => [c[0], c[1], c[2], c[3], c[6]])).toEqual([
      [1, 255, 0, 'GFSL05_09', 'GFL05-1'],
      [2, 255, 0, 'GFSL05_09', 'GFL05-2'],
      [3, 255, 0, 'GFSL05_09', 'GFL05-3'],
    ]);
  });

  it('cancelling the confirm writes nothing', async () => {
    const user = await openDialog();
    fireEvent.click(await screen.findByText('Bambu PLA Basic @BBL A1'));
    await waitFor(() => expect(btn(/Configure Slot/i)).toBeEnabled());
    fireEvent.click(btn(/Configure Slot/i));
    const confirm = await screen.findByText(tr('hyyz17200.bulk.spool.confirmConfigureTitle', { count: 3 }));
    await user.click(within(confirm.closest('div.fixed') as HTMLElement).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(tr('hyyz17200.bulk.spool.cancelled'))).toBeInTheDocument();
    expect(original.configure).not.toHaveBeenCalled();
    expect(original.save).not.toHaveBeenCalled();
  });

  it('resets every printer that is not printing', async () => {
    const user = await openDialog();
    await user.click(await screen.findByRole('button', { name: /Reset Slot/ }));
    // Upstream's own "Reset slot?" first, then the batch confirm.
    await user.click(within(screen.getByText('Reset slot?').closest('div.fixed') as HTMLElement).getByRole('button', { name: 'Reset Slot' }));
    const confirm = await screen.findByText(tr('hyyz17200.bulk.spool.confirmResetTitle', { count: 2 }));
    expect(screen.getByText(tr('hyyz17200.bulk.spool.resetPrintingSkipped', { names: 'P2' }))).toBeInTheDocument();
    await user.click(within(confirm.closest('div.fixed') as HTMLElement).getByRole('button', { name: tr('hyyz17200.bulk.spool.apply') }));
    await waitFor(() => expect(original.reset).toHaveBeenCalledTimes(2));
    expect(original.reset.mock.calls).toEqual([[1, 255, 0], [3, 255, 0]]);
  });

  it('puts upstream\'s calls back when the dialog closes', async () => {
    const user = await openDialog();
    expect(api.configureAmsSlot).not.toBe(original.configure);
    await user.click(btn('Cancel'));
    await waitFor(() => expect(api.configureAmsSlot).toBe(original.configure));
    expect(api.saveSlotPreset).toBe(original.save);
    expect(api.resetAmsSlot).toBe(original.reset);
  });
});
