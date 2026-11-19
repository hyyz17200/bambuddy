/**
 * "Move to location" on the printer card (hyyz17200): a menu item that opens
 * a tile per location; one tap moves the printer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const permissions = {
  granted: ['printers:read', 'printers:update'] as string[],
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

let assigns: { printer_ids: number[]; location: string | null }[];
let assignStatus: number;

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
    http.get('/api/v1/printer-locations/', () =>
      HttpResponse.json([
        { id: 1, name: 'Rack A', icon: null, color: '#ef4444', printer_count: 3 },
        { id: null, name: 'Workshop', icon: null, color: null, printer_count: 1 },
      ]),
    ),
    http.post('/api/v1/printer-locations/assign', async ({ request }) => {
      const body = (await request.json()) as { printer_ids: number[]; location: string | null };
      assigns.push(body);
      if (assignStatus !== 200) return HttpResponse.json({ detail: 'Only admins can do that' }, { status: assignStatus });
      return HttpResponse.json({ moved: body.printer_ids.length });
    }),
  );
  return render(<PrintersPage />);
}

async function openMoveDialog() {
  await waitFor(() => expect(document.getElementById('printer-card-1')).not.toBeNull());
  const card = document.getElementById('printer-card-1') as HTMLElement;
  const menu = card.querySelector('.lucide-ellipsis-vertical, .lucide-more-vertical')?.closest('button');
  expect(menu).toBeTruthy();
  fireEvent.click(menu as HTMLElement);
  fireEvent.click(await screen.findByRole('button', { name: 'Move to location' }));
  return screen.findByRole('dialog');
}

describe('printer card — move to location', () => {
  beforeEach(() => {
    assigns = [];
    assignStatus = 200;
    permissions.granted = ['printers:read', 'printers:update'];
  });

  it('moves with one tap on a location tile', async () => {
    renderPage();
    const dialog = await openMoveDialog();
    // Outside the card: a sorted or dragged card carries a transform.
    expect(document.getElementById('printer-card-1')?.contains(dialog)).toBe(false);

    fireEvent.click(await within(dialog).findByRole('button', { name: /Rack A/ }));

    await waitFor(() => expect(assigns).toEqual([{ printer_ids: [1], location: 'Rack A' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('marks the current location and does not move there', async () => {
    renderPage();
    const dialog = await openMoveDialog();
    const here = await within(dialog).findByRole('button', { name: /Workshop/ });
    expect((here as HTMLButtonElement).disabled).toBe(true);
    expect(here.getAttribute('aria-current')).toBe('true');
  });

  it('clears the location', async () => {
    renderPage();
    const dialog = await openMoveDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: /No location/ }));
    await waitFor(() => expect(assigns).toEqual([{ printer_ids: [1], location: null }]));
  });

  it('moves to a new location typed in', async () => {
    renderPage();
    const dialog = await openMoveDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: /New location/ }));
    const input = within(dialog).getByRole('textbox', { name: 'Location name' });
    fireEvent.change(input, { target: { value: '  Rack B  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(assigns).toEqual([{ printer_ids: [1], location: 'Rack B' }]));
  });

  it('stays open when the move is refused', async () => {
    assignStatus = 403;
    renderPage();
    const dialog = await openMoveDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: /Rack A/ }));
    await waitFor(() => expect(assigns).toHaveLength(1));
    expect(await screen.findByText(/Only admins can do that/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('is disabled without permission to edit printers', async () => {
    permissions.granted = ['printers:read'];
    renderPage();
    await waitFor(() => expect(document.getElementById('printer-card-1')).not.toBeNull());
    const card = document.getElementById('printer-card-1') as HTMLElement;
    fireEvent.click(card.querySelector('.lucide-ellipsis-vertical, .lucide-more-vertical')?.closest('button') as HTMLElement);
    const item = await screen.findByRole('button', { name: 'Move to location' });
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });
});
