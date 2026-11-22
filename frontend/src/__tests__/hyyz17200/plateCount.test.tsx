/**
 * Plate count (hyyz17200) on upstream's plate changer count (#3575): the card
 * menu sets a number, the multi-select toolbar refills several with a typed
 * number, and the Enhanced Settings tab sets capacities for many printers. All
 * through upstream's PATCH /printers/{id} and POST /printers/{id}/refill-plates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const permissions = { granted: [] as string[] };
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
import { Hyyz17200BulkActions } from '../../hyyz17200/bulkActions/BulkActions';
import { PlateCountSection } from '../../hyyz17200/plateCount/PlateCountSection';
import { isCounted, platesLeft } from '../../hyyz17200/plateCount/api';
import { enhancedSettingsSections } from '../../hyyz17200/settingsSections';
import type { Printer } from '../../api/client';

const printer = (id: number, name: string, extra: Partial<Printer> = {}) =>
  ({
    id,
    name,
    model: 'A1',
    ip_address: `10.0.0.${id}`,
    serial_number: `SN${id}`,
    access_code: '12345678',
    enabled: true,
    is_active: true,
    nozzle_diameter: 0.4,
    nozzle_type: 'stainless_steel',
    location: 'Shelf 1',
    auto_archive: true,
    plate_capacity: 10,
    plates_remaining: 7,
    plate_changer_show_count: true,
    require_plate_clear: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...extra,
  }) as unknown as Printer;

const calls: { method: string; path: string; body?: unknown }[] = [];

beforeEach(() => {
  permissions.granted = ['printers:read', 'printers:update', 'printers:clear_plate', 'settings:update'];
  calls.length = 0;
  server.use(
    http.patch('/api/v1/printers/:id', async ({ request, params }) => {
      const body = await request.json();
      calls.push({ method: 'PATCH', path: `/printers/${params.id}`, body });
      return HttpResponse.json(printer(Number(params.id), 'x'));
    }),
    http.post('/api/v1/printers/:id/refill-plates', ({ params }) => {
      calls.push({ method: 'POST', path: `/printers/${params.id}/refill-plates` });
      return HttpResponse.json(printer(Number(params.id), 'x', { plates_remaining: 10 }));
    }),
    http.get('/api/v1/settings/', () => HttpResponse.json({ require_plate_clear: false })),
  );
});

afterEach(() => cleanup());

describe('helpers', () => {
  it('is a tab of the Enhanced Settings page', () => {
    expect(enhancedSettingsSections.map((s) => s.id)).toContain('plate-count');
  });

  it('reads the count the way upstream does', () => {
    expect(isCounted(printer(1, 'a'))).toBe(true);
    expect(isCounted(printer(1, 'a', { plate_capacity: null }))).toBe(false);
    expect(platesLeft(printer(1, 'a'))).toBe(7);
    // A capacity without a count reads as empty, like upstream's scheduler.
    expect(platesLeft(printer(1, 'a', { plates_remaining: null }))).toBe(0);
    expect(platesLeft(printer(1, 'a', { plate_capacity: null }))).toBeNull();
  });
});

describe('printer card', () => {
  function renderPage(p: Printer) {
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([p])),
      http.get('/api/v1/printers/:id/status', () =>
        HttpResponse.json({ connected: true, state: 'IDLE', temperatures: {}, vt_tray: [], ams: [] }),
      ),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
      http.get('/api/v1/hyyz17200/printers/intake-stops', () => HttpResponse.json([])),
    );
    return render(<PrintersPage />);
  }

  async function openMenu() {
    await waitFor(() => expect(document.getElementById('printer-card-1')).not.toBeNull());
    const card = document.getElementById('printer-card-1') as HTMLElement;
    const menu = card.querySelector('.lucide-ellipsis-vertical, .lucide-more-vertical')?.closest('button');
    fireEvent.click(menu as HTMLElement);
  }

  it('sets a number from the card menu', async () => {
    renderPage(printer(1, 'A1-01'));
    await openMenu();
    fireEvent.click(await screen.findByRole('button', { name: 'Set plate count…' }));

    const input = await screen.findByRole('spinbutton', { name: 'Plates left' });
    expect((input as HTMLInputElement).value).toBe('7');
    fireEvent.change(input, { target: { value: '11' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: '/printers/1', body: { plates_remaining: 4 } }]));
  });

  it('is not in the menu without a capacity', async () => {
    renderPage(printer(1, 'A1-01', { plate_capacity: null, plates_remaining: null }));
    await openMenu();
    await screen.findByRole('button', { name: /Move to location/ });
    expect(screen.queryByRole('button', { name: 'Set plate count…' })).toBeNull();
  });

  it('leaves the count beside the name to upstream', async () => {
    renderPage(printer(1, 'A1-01'));
    await waitFor(() => expect(document.getElementById('printer-card-1')).not.toBeNull());
    expect(screen.queryByTestId('hyyz17200-plate-badge')).toBeNull();
  });
});

describe('multi-select toolbar', () => {
  const selection = [
    printer(1, 'A1-01'),
    printer(2, 'A1-02', { plate_capacity: 6, plates_remaining: 0 }),
    printer(3, 'P1-01', { plate_capacity: null, plates_remaining: null }),
  ];

  async function openDialog() {
    const user = userEvent.setup();
    render(<Hyyz17200BulkActions selectedIds={new Set([1, 2, 3])} printers={selection} disabled={false} />);
    const button = await screen.findByRole('button', { name: 'Refill plates' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await screen.findByText('Refill plates on 2 printers');
    return user;
  }

  it('sets the counted printers to the number typed in, each up to its capacity', async () => {
    const user = await openDialog();
    const input = await screen.findByRole('spinbutton', { name: 'Plates' });
    expect((input as HTMLInputElement).value).toBe('10');
    expect(screen.getByText('1 printer without a plate changer capacity is skipped.')).toBeTruthy();
    await user.clear(input);
    await user.type(input, '8');
    await user.click(screen.getByRole('button', { name: 'Set 8 plates' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'PATCH', path: '/printers/1', body: { plates_remaining: 8 } },
        // Holds 6: full, so upstream's refill.
        { method: 'POST', path: '/printers/2/refill-plates' },
      ]),
    );
  });

  it('only refills to full without the permission to edit printers', async () => {
    permissions.granted = ['printers:read', 'printers:clear_plate'];
    const user = await openDialog();
    expect(screen.getByRole('spinbutton', { name: 'Plates' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Set 10 plates' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.every((c) => c.path.endsWith('/refill-plates'))).toBe(true);
  });

  it('is not offered when no printer counts plates', async () => {
    render(
      <Hyyz17200BulkActions
        selectedIds={new Set([1])}
        printers={[printer(1, 'A1-01', { plate_capacity: null })]}
        disabled={false}
      />,
    );
    await screen.findByRole('button', { name: /CSV/i });
    expect(screen.queryByRole('button', { name: 'Refill plates' })).toBeNull();
  });
});

describe('Enhanced Settings tab', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/printers/', () =>
        HttpResponse.json([
          printer(1, 'A1-01'),
          printer(2, 'A1-02', { plates_remaining: 0 }),
          printer(3, 'P1-01', { model: 'P1S', plate_capacity: null, plates_remaining: null, require_plate_clear: true }),
        ]),
      ),
    );
  });

  it('lists every printer with upstream\'s count', async () => {
    render(<PlateCountSection />);
    const row = (await screen.findByText('A1-01')).closest('tr') as HTMLElement;
    expect(within(row).getByText('7/10')).toBeTruthy();
    const empty = screen.getByText('A1-02').closest('tr') as HTMLElement;
    expect(empty.textContent).toContain('queue skips it');
    const p1 = screen.getByText('P1-01').closest('tr') as HTMLElement;
    expect(within(p1).getByText('Not counted')).toBeTruthy();
    expect(screen.getByText('2 of 3 printers counted, 1 empty.')).toBeTruthy();
  });

  it('sets and clears a capacity', async () => {
    render(<PlateCountSection />);
    const input = await screen.findByRole('spinbutton', { name: 'Plate changer capacity of P1-01 (empty: not counted)' });
    fireEvent.change(input, { target: { value: '6' } });
    fireEvent.blur(input);
    await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: '/printers/3', body: { plate_capacity: 6 } }]));

    calls.length = 0;
    const a1 = screen.getByRole('spinbutton', { name: 'Plate changer capacity of A1-01 (empty: not counted)' });
    fireEvent.change(a1, { target: { value: '' } });
    fireEvent.blur(a1);
    await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: '/printers/1', body: { plate_capacity: null } }]));
  });

  it('sets many at once', async () => {
    const user = userEvent.setup();
    render(<PlateCountSection />);
    await screen.findByText('A1-01');
    await user.click(screen.getByRole('checkbox', { name: 'A1-01' }));
    await user.click(screen.getByRole('checkbox', { name: 'A1-02' }));

    await user.click(screen.getByRole('button', { name: 'Refill to full' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.every((c) => c.method === 'POST' && c.path.endsWith('/refill-plates'))).toBe(true);

    calls.length = 0;
    await user.click(screen.getByRole('button', { name: 'Hide on card' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => c.body)).toEqual([{ plate_changer_show_count: false }, { plate_changer_show_count: false }]);

    calls.length = 0;
    const capacity = screen.getByRole('spinbutton', { name: 'Capacity for the selected printers' });
    await user.clear(capacity);
    await user.type(capacity, '12');
    await user.click(screen.getByRole('button', { name: 'Set capacity' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => c.body)).toEqual([{ plate_capacity: 12 }, { plate_capacity: 12 }]);
  });
});
