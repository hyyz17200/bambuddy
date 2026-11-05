/**
 * Bulk printer import (hyyz17200): CSV parsing, the row checks, and the page
 * that reads serials from IPs and adds the rows one at a time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const importApi = vi.hoisted(() => ({
  probePrinters: vi.fn(),
  importPrinter: vi.fn(),
  startScan: vi.fn(),
  getScan: vi.fn(),
  stopScan: vi.fn(),
}));
vi.mock('../../hyyz17200/printerImport/api', () => importApi);

const clientApi = vi.hoisted(() => ({ getPrinters: vi.fn(), getPrinterStatus: vi.fn() }));
const discovery = vi.hoisted(() => ({
  getInfo: vi.fn(),
  startSubnetScan: vi.fn(),
  getScanStatus: vi.fn(),
  getDiscoveredPrinters: vi.fn(),
  stopSubnetScan: vi.fn(),
  startDiscovery: vi.fn(),
  stopDiscovery: vi.fn(),
}));
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: { ...actual.api, ...clientApi }, discoveryApi: discovery };
});

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({ authEnabled: false, loading: false, user: null, hasPermission: () => true }),
  };
});

import { ToastProvider } from '../../contexts/ToastContext';
import { Hyyz17200RequestError } from '../../hyyz17200/request';
import { PrinterImportPage } from '../../hyyz17200/printerImport/PrinterImportPage';
import {
  emptyRow, mergeCsvRows, mergeDiscovered, normalizeModel, parseCsv, rowProblems, rowsFromCsv,
} from '../../hyyz17200/printerImport/rows';
import '../../i18n';

describe('CSV', () => {
  it('handles quotes, CRLF, a BOM and blank lines', () => {
    const text = `${String.fromCharCode(0xfeff)}a,"b, c","say ""hi"""\r\n\r\n1,2,3\r\n`;
    expect(parseCsv(text)).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });

  it('guesses semicolon and tab delimiters', () => {
    expect(parseCsv('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('reads Chinese headers in any order', () => {
    const [row] = rowsFromCsv('位置,访问码,IP 地址,名称,型号,序列号（可空）,自动归档\nRack 2,01234567,10.0.0.7,P1-07,p1s,,否\n');
    expect(row).toMatchObject({
      name: 'P1-07', ip: '10.0.0.7', accessCode: '01234567', model: 'P1S', location: 'Rack 2',
      serial: '', serialSource: null, autoArchive: false,
    });
  });

  it('takes the default column order without a header', () => {
    const [row] = rowsFromCsv('A1-01,192.168.1.101,12345678,a1 mini,Rack 1,03919c000000001\n');
    expect(row).toMatchObject({
      name: 'A1-01', ip: '192.168.1.101', accessCode: '12345678', model: 'A1 Mini', location: 'Rack 1',
      serial: '03919C000000001', serialSource: 'csv',
    });
  });

  it('normalizes model names and SSDP codes', () => {
    expect(normalizeModel('N2S')).toBe('A1');
    expect(normalizeModel('C12')).toBe('P1S');
    expect(normalizeModel('Bambu Lab X1 Carbon')).toBe('X1C');
    expect(normalizeModel('h2d pro')).toBe('H2D Pro');
    expect(normalizeModel('Ender 3')).toBe('Ender 3');
  });
});

describe('row checks', () => {
  const good = () =>
    emptyRow({ name: 'A1-01', ip: '10.0.0.1', accessCode: '12345678', serial: '03919C000000001', model: 'A1' });
  const keys = (problems: ReturnType<typeof rowProblems>) => problems.map((p) => `${p.field}:${p.level}:${p.key}`);

  it('passes a complete row', () => {
    const row = good();
    expect(rowProblems(row, [row], [])).toEqual([]);
  });

  it('blocks missing fields and duplicates, warns on soft issues', () => {
    const a = good();
    const b = { ...good(), name: 'A1-01', accessCode: '1234567', model: '' };
    const blank = emptyRow();
    expect(keys(rowProblems(b, [a, b], []))).toEqual([
      'name:warning:duplicateName',
      'ip:error:duplicateInTable',
      'accessCode:warning:shortCode',
      'serial:error:duplicateInTable',
      'model:warning:noModel',
    ]);
    expect(keys(rowProblems(blank, [blank], []))).toEqual([
      'name:error:required',
      'ip:error:required',
      'accessCode:error:required',
      'serial:error:required',
      'model:warning:noModel',
    ]);
  });

  it('blocks printers already in Bambuddy', () => {
    const row = good();
    const existing = [{ name: 'Old', serial_number: '03919C000000001', ip_address: '10.0.0.1' }];
    expect(keys(rowProblems(row, [row], existing))).toEqual(['ip:error:alreadyAdded', 'serial:error:alreadyAdded']);
  });

  it('says when the serial could not be read', () => {
    const row = { ...good(), serial: '', probe: 'failed' as const };
    expect(keys(rowProblems(row, [row], []))).toEqual(['serial:error:notRead']);
    const reading = { ...row, probe: 'reading' as const };
    expect(rowProblems(reading, [reading], [])).toEqual([]);
  });
});

describe('merging', () => {
  const existing = [{ name: 'Old', serial_number: '01P00A000000009', ip_address: '10.0.0.9' }];

  it('adds scanned printers in IP order, leaving out known ones', () => {
    const rows = mergeDiscovered(
      [],
      [
        { serial: 'unknown-10-0-0-20', name: 'Printer at 10.0.0.20', ip_address: '10.0.0.20', model: null },
        { serial: '22E8BJ5A2101411', name: 'NoNo-P2S', ip_address: '10.0.0.3', model: 'N7' },
        { serial: '01P00A000000009', name: 'Old', ip_address: '10.0.0.9', model: 'C12' },
      ],
      existing,
    );
    expect(rows.map((r) => [r.ip, r.serial, r.name, r.model, r.serialSource])).toEqual([
      ['10.0.0.3', '22E8BJ5A2101411', 'NoNo-P2S', 'P2S', 'ssdp'],
      ['10.0.0.20', '', '', '', null],
    ]);
  });

  it('only fills what a table row lacks, and is stable when repeated', () => {
    const row = emptyRow({ ip: '10.0.0.3', name: 'Mine', accessCode: '12345678' });
    const found = [{ serial: '22E8BJ5A2101411', name: 'NoNo-P2S', ip_address: '10.0.0.3', model: 'N7' }];
    const once = mergeDiscovered([row], found, []);
    expect(once[0]).toMatchObject({ name: 'Mine', accessCode: '12345678', serial: '22E8BJ5A2101411', model: 'P2S' });
    expect(mergeDiscovered(once, found, [])).toBe(once);
  });

  it('merges a CSV into the table by IP', () => {
    const scanned = emptyRow({ ip: '10.0.0.3', name: 'NoNo-P2S', serial: '22E8BJ5A2101411', model: 'P2S' });
    const merged = mergeCsvRows([scanned], rowsFromCsv(['ip,access_code', '10.0.0.3,12345678', '10.0.0.4,87654321'].join('\n')));
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ name: 'NoNo-P2S', serial: '22E8BJ5A2101411', accessCode: '12345678' });
    expect(merged[1]).toMatchObject({ ip: '10.0.0.4', accessCode: '87654321' });
  });
});

describe('PrinterImportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientApi.getPrinters.mockResolvedValue([]);
    clientApi.getPrinterStatus.mockResolvedValue({ connected: true });
    discovery.getInfo.mockResolvedValue({ is_docker: false, ssdp_running: false, scan_running: false, subnets: ['192.168.1.0/24'] });
    importApi.startScan.mockResolvedValue({ running: true, subnet: '192.168.0.0/20', scanned: 0, total: 4094, printers: [] });
    importApi.stopScan.mockResolvedValue({ running: false, subnet: null, scanned: 0, total: 0, printers: [] });
  });

  function renderPage() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter>
            <PrinterImportPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  async function pasteCsv(text: string) {
    await userEvent.click(screen.getByRole('button', { name: /Paste CSV/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste CSV' }), { target: { value: text } });
    await userEvent.click(screen.getByRole('button', { name: 'Load' }));
  }

  it('reads serials from the IPs, then adds the rows in order', async () => {
    importApi.probePrinters.mockResolvedValue([
      { ip_address: '10.0.0.1', serial_number: '03919C000000001', name: 'ssdp-name', model: 'N2S', source: 'ssdp' },
      { ip_address: '10.0.0.2', serial_number: '01P00A000000002', name: null, model: null, source: 'certificate' },
    ]);
    importApi.importPrinter
      .mockResolvedValueOnce({ id: 11, name: 'A1-01' })
      .mockRejectedValueOnce(new Hyyz17200RequestError(400, 'printer_connection_failed'));
    renderPage();

    await pasteCsv('name,ip,access_code,model\nA1-01,10.0.0.1,12345678,\nP1-02,10.0.0.2,87654321,P1S\n');

    const serials = await screen.findAllByRole('textbox', { name: 'Serial number' });
    await waitFor(() => expect(serials[0]).toHaveValue('03919C000000001'));
    expect(serials[1]).toHaveValue('01P00A000000002');
    expect(importApi.probePrinters).toHaveBeenCalledWith(['10.0.0.1', '10.0.0.2']);
    // SSDP's model filled the empty one; the name from the CSV is kept.
    const models = screen.getAllByRole('combobox', { name: 'Model' });
    expect(models[0]).toHaveValue('A1');
    expect(screen.getAllByRole('textbox', { name: 'Name' })[0]).toHaveValue('A1-01');

    await userEvent.click(screen.getByRole('button', { name: 'Add 2 printers' }));

    await waitFor(() => expect(importApi.importPrinter).toHaveBeenCalledTimes(2));
    expect(importApi.importPrinter).toHaveBeenNthCalledWith(
      1,
      {
        name: 'A1-01', ip_address: '10.0.0.1', access_code: '12345678', serial_number: '03919C000000001',
        model: 'A1', location: null, auto_archive: true,
      },
      false,
    );
    const rows = screen.getAllByTestId('import-row');
    await waitFor(() => expect(within(rows[0]).getByText('Connected')).toBeInTheDocument());
    expect(within(rows[1]).getByText(/Could not connect/)).toBeInTheDocument();
    // The added row is locked; the failed one stays editable for a retry.
    expect(within(rows[0]).getByRole('textbox', { name: 'Name' })).toBeDisabled();
    expect(within(rows[1]).getByRole('textbox', { name: 'Name' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add 1 printer' })).toBeEnabled();
  });

  it('passes the verify choice and keeps rows that need fixing out', async () => {
    importApi.probePrinters.mockResolvedValue([
      { ip_address: '10.0.0.9', serial_number: null, name: null, model: null, source: null },
    ]);
    importApi.importPrinter.mockResolvedValue({ id: 12, name: 'x' });
    renderPage();

    await pasteCsv('A1-01,10.0.0.1,12345678,A1,,03919C000000001\nA1-09,10.0.0.9,12345678,A1,,\n');

    const rows = await screen.findAllByTestId('import-row');
    await waitFor(() => expect(within(rows[1]).getByText('Needs fixing')).toBeInTheDocument());
    expect(importApi.probePrinters).toHaveBeenCalledWith(['10.0.0.9']);

    await userEvent.click(screen.getByRole('checkbox', { name: /Test the connection/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Add 1 printer' }));

    await waitFor(() => expect(importApi.importPrinter).toHaveBeenCalledTimes(1));
    expect(importApi.importPrinter.mock.calls[0][0].serial_number).toBe('03919C000000001');
    expect(importApi.importPrinter.mock.calls[0][1]).toBe(true);
  });

  it('shows why a subnet cannot be scanned', async () => {
    importApi.startScan.mockRejectedValue(new Hyyz17200RequestError(400, 'subnet_too_large'));
    renderPage();
    const scanButton = await screen.findByRole('button', { name: 'Scan' });
    await waitFor(() => expect(scanButton).toBeEnabled());
    await userEvent.click(scanButton);
    expect(await screen.findByText(/At most a \/16/)).toBeInTheDocument();
  });

  it('scans the subnet into the table, then Enter walks the access codes', async () => {
    importApi.getScan.mockResolvedValue({
      running: false,
      subnet: '192.168.0.0/20',
      scanned: 4094,
      total: 4094,
      printers: [
        // No broadcast heard: the serial stands in for the name.
        { ip_address: '192.168.1.149', serial_number: '039199471100344', name: null, model: null },
        { ip_address: '192.168.1.10', serial_number: '22E8BJ5A2101411', name: 'NoNo-P2S', model: 'N7' },
      ],
    });
    renderPage();

    const scanButton = await screen.findByRole('button', { name: 'Scan' });
    await waitFor(() => expect(scanButton).toBeEnabled());
    await userEvent.click(scanButton);

    expect(importApi.startScan).toHaveBeenCalledWith('192.168.1.0/24');
    const names = await screen.findAllByRole('textbox', { name: 'Name' }, { timeout: 3000 });
    expect(names.map((i) => (i as HTMLInputElement).value)).toEqual(['NoNo-P2S', '039199471100344']);
    expect(screen.getAllByRole('textbox', { name: 'Serial number' }).map((i) => (i as HTMLInputElement).value)).toEqual([
      '22E8BJ5A2101411',
      '039199471100344',
    ]);
    expect(screen.getAllByRole('combobox', { name: 'Model' }).map((i) => (i as HTMLSelectElement).value)).toEqual(['P2S', '']);
    // Every printer the scan found came with its serial: nothing left to probe.
    expect(importApi.probePrinters).not.toHaveBeenCalled();

    const codes = screen.getAllByRole('textbox', { name: 'Access code' });
    codes[0].focus();
    await userEvent.keyboard('12345678{Enter}');
    expect(codes[1]).toHaveFocus();
    await userEvent.keyboard('87654321');
    expect(screen.getByRole('button', { name: 'Add 2 printers' })).toBeEnabled();
  });

  it('reads the serial of a printer the scan found without one', async () => {
    importApi.getScan.mockResolvedValue({
      running: false,
      subnet: '192.168.1.0/24',
      scanned: 254,
      total: 254,
      printers: [{ ip_address: '192.168.1.20', serial_number: null, name: null, model: null }],
    });
    importApi.probePrinters.mockResolvedValue([
      { ip_address: '192.168.1.20', serial_number: '0948AB000000001', name: 'H2D-01', model: null, source: 'ssdp' },
    ]);
    renderPage();

    const scanButton = await screen.findByRole('button', { name: 'Scan' });
    await waitFor(() => expect(scanButton).toBeEnabled());
    await userEvent.click(scanButton);

    await waitFor(() => expect(importApi.probePrinters).toHaveBeenCalledWith(['192.168.1.20']), { timeout: 3000 });
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'Serial number' }) as HTMLInputElement).value).toBe('0948AB000000001'),
    );
  });
});
