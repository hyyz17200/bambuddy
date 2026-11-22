/**
 * "Send maintenance G-code" on the printer card (hyyz17200): pick a sliced file
 * from the maintenance folder (subfolders included) and send it now.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const permissions = {
  granted: ['printers:read', 'printers:control', 'queue:create'] as string[],
};

const mockUseAuth = {
  user: { id: 1, username: 'operator', permissions: [] as string[] },
  authEnabled: true,
  loading: false,
  isAdmin: false,
  login: vi.fn(),
  loginWithToken: vi.fn(),
  logout: vi.fn(),
  refreshAuth: vi.fn(),
  hasPermission: vi.fn((permission: string) => permissions.granted.includes(permission)),
  hasAnyPermission: vi.fn(() => true),
  canModify: vi.fn(() => true),
};

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});

import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { normalizeMaintenance } from '../../hyyz17200/maintenanceJob/maintenanceApi';

const mockPrinter = {
  id: 1,
  name: 'A1-01',
  ip_address: '192.168.1.100',
  serial_number: '01P00A000000001',
  access_code: '12345678',
  model: 'A1',
  enabled: true,
  nozzle_diameter: 0.4,
  nozzle_type: 'stainless_steel',
  location: null,
  auto_archive: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

function libraryFile(id: number, filename: string, folderId: number, model: string | null, printName?: string) {
  return {
    id,
    folder_id: folderId,
    is_external: false,
    filename,
    file_type: '3mf',
    file_size: 10,
    thumbnail_path: null,
    print_count: 0,
    duplicate_count: 0,
    created_by_id: null,
    created_by_username: null,
    created_at: '2024-01-01T00:00:00Z',
    fs_modified_at: null,
    print_name: printName ?? null,
    print_time_seconds: 90,
    filament_used_grams: null,
    sliced_for_model: model,
    tags: [],
    variant_group_id: null,
    variant_count: 0,
    external_url: null,
    has_notes: false,
    photo_count: 0,
  };
}

function folder(id: number, name: string, children: unknown[] = []) {
  return {
    id,
    name,
    parent_id: null,
    project_id: null,
    archive_id: null,
    project_name: null,
    archive_name: null,
    is_external: false,
    external_path: null,
    external_readonly: false,
    file_count: 0,
    latest_activity_at: null,
    created_by_id: null,
    shared: false,
    can_write: true,
    can_rename: true,
    can_delete: true,
    children,
  };
}

let folderId: number | null;
let fileQueries: URLSearchParams[];
let sends: { printerId: string; body: { library_file_id: number; stop_intake: boolean; uses_plate?: boolean } }[];
let plateCounted: boolean;
let sendError: string | null;

function renderPage() {
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json([mockPrinter])),
    http.get('/api/v1/printers/:id/status', () =>
      HttpResponse.json({
        connected: true,
        state: 'IDLE',
        temperatures: { nozzle: 25, bed: 25, chamber: 25 },
        vt_tray: [],
        ams: [],
      }),
    ),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
    http.get('/api/v1/hyyz17200/printers/intake-stops', () => HttpResponse.json([])),
    http.get('/api/v1/hyyz17200/printers/plates', () =>
      HttpResponse.json({
        enabled: plateCounted,
        default_capacity: 10,
        plate_clear_setting: false,
        printers: plateCounted
          ? [{ printer_id: 1, applicable: true, disabled: false, capacity: null, effective_capacity: 10, counted: true, plates: 5, in_use: 0, available: 5, held: false, updated_at: null, updated_by: null }]
          : [],
      }),
    ),
    http.get('/api/v1/hyyz17200/settings', () => HttpResponse.json({ maintenance: { folder_id: folderId } })),
    http.get('/api/v1/library/folders', () =>
      HttpResponse.json([folder(10, 'Maintenance', [folder(11, 'Swaps')]), folder(20, 'Prints')]),
    ),
    http.get('/api/v1/library/files', ({ request }) => {
      fileQueries.push(new URL(request.url).searchParams);
      return HttpResponse.json([
        libraryFile(1, 'swap.gcode.3mf', 11, 'A1', 'Plate swap'),
        libraryFile(2, 'wipe.gcode.3mf', 10, null),
        libraryFile(3, 'p1-swap.gcode.3mf', 10, 'P1S'),
        libraryFile(4, 'model.3mf', 10, null),
      ]);
    }),
    http.post('/api/v1/hyyz17200/printers/:id/maintenance-job', async ({ params, request }) => {
      const body = (await request.json()) as { library_file_id: number; stop_intake: boolean };
      sends.push({ printerId: String(params.id), body });
      if (sendError) return HttpResponse.json({ detail: sendError }, { status: 409 });
      return HttpResponse.json({ queue_item_id: 99, intake_stopped: body.stop_intake });
    }),
  );
  return render(<PrintersPage />);
}

async function openDialog() {
  await waitFor(() => expect(document.getElementById('printer-card-1')).not.toBeNull());
  const card = document.getElementById('printer-card-1') as HTMLElement;
  const menu = card.querySelector('.lucide-ellipsis-vertical, .lucide-more-vertical')?.closest('button');
  expect(menu).toBeTruthy();
  fireEvent.click(menu as HTMLElement);
  fireEvent.click(await screen.findByRole('button', { name: 'Send maintenance G-code' }));
  return screen.findByRole('dialog');
}

describe('printer card — send maintenance G-code', () => {
  beforeEach(() => {
    folderId = 10;
    fileQueries = [];
    sends = [];
    sendError = null;
    plateCounted = false;
    permissions.granted = ['printers:read', 'printers:control', 'queue:create'];
    // setup.ts stubs localStorage with no-ops; this test needs it to keep values.
    const store = new Map<string, string>();
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => store.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
      store.set(key, value);
    });
  });

  it('lists the sliced files for this model, subfolders included', async () => {
    renderPage();
    const dialog = await openDialog();

    expect(await within(dialog).findByRole('button', { name: /Plate swap/ })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /wipe\.gcode\.3mf/ })).toBeTruthy();
    // Sliced for another model, and not sliced at all.
    expect(within(dialog).queryByRole('button', { name: /p1-swap/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /model\.3mf/ })).toBeNull();
    expect(within(dialog).getByText(/1 file sliced for another model/)).toBeTruthy();
    // The subfolder path is shown under the name.
    expect(within(dialog).getByText(/Swaps/)).toBeTruthy();

    const query = fileQueries[0];
    expect(query.get('folder_id')).toBe('10');
    expect(query.get('recursive')).toBe('true');
    // Outside the card: a sorted or dragged card carries a transform.
    expect(document.getElementById('printer-card-1')?.contains(dialog)).toBe(false);
  });

  it('sends the picked file and stops taking jobs by default', async () => {
    renderPage();
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: /Plate swap/ }));
    const box = within(dialog).getByRole('checkbox', { name: /stop taking jobs after sending/i }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(within(dialog).queryByRole('checkbox', { name: /plate is clear/i })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send now' }));

    await waitFor(() => expect(sends).toEqual([{ printerId: '1', body: { library_file_id: 1, stop_intake: true, uses_plate: true } }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('can be sent without stopping taking jobs', async () => {
    renderPage();
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: /Plate swap/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /stop taking jobs after sending/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send now' }));

    await waitFor(() => expect(sends).toEqual([{ printerId: '1', body: { library_file_id: 1, stop_intake: false, uses_plate: true } }]));
  });

  it('asks whether the job uses a plate only where plates are counted', async () => {
    renderPage();
    let dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: /Plate swap/ }));
    expect(within(dialog).queryByRole('checkbox', { name: /uses a plate/i })).toBeNull();
    cleanup();

    plateCounted = true;
    renderPage();
    dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: /Plate swap/ }));
    const box = (await within(dialog).findByRole('checkbox', { name: /uses a plate/i })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send now' }));

    await waitFor(() =>
      expect(sends).toEqual([{ printerId: '1', body: { library_file_id: 1, stop_intake: true, uses_plate: false } }]),
    );
  });

  it('stays open and says why when the printer refuses', async () => {
    sendError = 'busy';
    renderPage();
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: /Plate swap/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send now' }));

    expect(await screen.findByText(/A1-01 is busy/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('points to the settings when no folder is set', async () => {
    folderId = null;
    renderPage();
    const dialog = await openDialog();

    expect(await within(dialog).findByText(/No maintenance folder is set/)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: /Enhanced Settings/ }).getAttribute('href')).toBe(
      '/hyyz17200/settings?tab=maintenance',
    );
    expect(fileQueries).toEqual([]);
  });

  it('is disabled without permission to control the printer', async () => {
    permissions.granted = ['printers:read', 'queue:create'];
    renderPage();
    await waitFor(() => expect(document.getElementById('printer-card-1')).not.toBeNull());
    const card = document.getElementById('printer-card-1') as HTMLElement;
    fireEvent.click(card.querySelector('.lucide-ellipsis-vertical, .lucide-more-vertical')?.closest('button') as HTMLElement);

    const item = (await screen.findByRole('button', { name: 'Send maintenance G-code' })) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
  });
});

describe('maintenance settings', () => {
  it('normalizes the folder id', () => {
    expect(normalizeMaintenance({ folder_id: 5 })).toEqual({ folder_id: 5 });
    expect(normalizeMaintenance({ folder_id: '5' })).toEqual({ folder_id: null });
    expect(normalizeMaintenance(undefined)).toEqual({ folder_id: null });
  });
});
