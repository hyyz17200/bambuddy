/**
 * "Stop taking jobs" on the printer card (hyyz17200): a menu toggle, a yellow
 * pill and Print button while it is on, and a dialog that offers to resume
 * before printing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const permissions = {
  granted: ['printers:read', 'printers:update', 'library:upload', 'queue:create'] as string[],
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
  location: 'Workshop',
  auto_archive: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

let stopped: boolean;
const writes: { printerId: string; stopped: boolean }[] = [];

function renderPage() {
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json([mockPrinter])),
    http.get('/api/v1/printers/:id/status', () =>
      HttpResponse.json({
        connected: true,
        state: 'RUNNING',
        progress: 40,
        layer_num: 10,
        total_layers: 100,
        temperatures: { nozzle: 220, bed: 60, chamber: 25 },
        remaining_time: 30,
        filename: 'part.3mf',
        wifi_signal: -29,
        speed_level: 2,
        vt_tray: [],
        ams: [],
      }),
    ),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
    http.get('/api/v1/hyyz17200/printers/intake-stops', () =>
      HttpResponse.json(stopped ? [{ printer_id: 1, stopped_at: '2026-11-03T10:00:00', stopped_by: 'operator' }] : []),
    ),
    http.put('/api/v1/hyyz17200/printers/:id/intake', async ({ request, params }) => {
      const body = (await request.json()) as { stopped: boolean };
      writes.push({ printerId: String(params.id), stopped: body.stopped });
      stopped = body.stopped;
      return HttpResponse.json(body);
    }),
  );
  return render(<PrintersPage />);
}

async function printButton(): Promise<HTMLElement> {
  await waitFor(() => expect(document.getElementById('printer-card-1')).not.toBeNull());
  const card = document.getElementById('printer-card-1') as HTMLElement;
  return within(card).findByRole('button', { name: /^Print$/ });
}

describe('printer card — stop taking jobs', () => {
  beforeEach(() => {
    stopped = false;
    writes.length = 0;
  });

  it('turns on from the card menu', async () => {
    renderPage();
    await printButton();

    const card = document.getElementById('printer-card-1') as HTMLElement;
    const menu = card.querySelector('.lucide-ellipsis-vertical, .lucide-more-vertical')?.closest('button');
    expect(menu).toBeTruthy();
    fireEvent.click(menu as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop taking jobs' }));

    await waitFor(() => expect(writes).toEqual([{ printerId: '1', stopped: true }]));
    expect(await screen.findByText('Not taking jobs')).toBeTruthy();
  });

  it('shows yellow and keeps green otherwise', async () => {
    renderPage();
    expect((await printButton()).className).toContain('!bg-bambu-green');
    expect(screen.queryByText('Not taking jobs')).toBeNull();
  });

  it('asks to resume before printing, then resumes', async () => {
    stopped = true;
    renderPage();
    await screen.findByText('Not taking jobs');
    const button = await printButton();
    await waitFor(() => expect(button.className).toContain('!bg-yellow-400'));
    expect(button.className).not.toContain('!bg-bambu-green');

    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume and continue' }));

    await waitFor(() => expect(writes).toEqual([{ printerId: '1', stopped: false }]));
    await waitFor(() => expect(screen.queryByText('Not taking jobs')).toBeNull());
  });

  it('leaves it stopped when the dialog is cancelled', async () => {
    stopped = true;
    renderPage();
    await screen.findByText('Not taking jobs');

    fireEvent.click(await printButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(writes).toEqual([]);
    expect(screen.getByText('Not taking jobs')).toBeTruthy();
  });

  it('turns the S card dot yellow', async () => {
    stopped = true;
    const getItem = vi
      .spyOn(localStorage, 'getItem')
      .mockImplementation((key: string) => (key === 'printerCardSize' ? '1' : null));
    try {
      renderPage();
      const dot = await screen.findByTitle('Not taking jobs');
      expect(dot.className).toContain('bg-yellow-400');
      expect(dot.className).not.toContain('bg-status-ok');
    } finally {
      getItem.mockRestore();
    }
  });

  it('cannot resume without permission to edit printers', async () => {
    stopped = true;
    permissions.granted = ['printers:read', 'library:upload', 'queue:create'];
    try {
      renderPage();
      await screen.findByText('Not taking jobs');

      fireEvent.click(await printButton());

      expect(await screen.findByText(/Someone who can edit printers/)).toBeTruthy();
      expect(
        (screen.getByRole('button', { name: 'Resume and continue' }) as HTMLButtonElement).disabled,
      ).toBe(true);
    } finally {
      permissions.granted = ['printers:read', 'printers:update', 'library:upload', 'queue:create'];
    }
  });
});
