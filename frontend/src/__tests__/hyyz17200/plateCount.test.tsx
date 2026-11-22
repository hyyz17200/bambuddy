/**
 * Plate count (hyyz17200): the count beside the printer name refills with one
 * tap, the card menu sets a number, the multi-select toolbar refills several
 * with a typed number, and the Enhanced Settings tab switches printers.
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
import { normalizePlateCount, plateLevel, type PrinterPlates } from '../../hyyz17200/plateCount/api';
import { enhancedSettingsSections } from '../../hyyz17200/settingsSections';
import type { Printer } from '../../api/client';

const BASE = '/api/v1/hyyz17200';

const printer = (id: number, name: string, model = 'A1') =>
  ({
    id,
    name,
    model,
    ip_address: `10.0.0.${id}`,
    serial_number: `SN${id}`,
    access_code: '12345678',
    enabled: true,
    is_active: true,
    nozzle_diameter: 0.4,
    nozzle_type: 'stainless_steel',
    location: 'Shelf 1',
    auto_archive: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }) as unknown as Printer;

function entry(id: number, extra: Partial<PrinterPlates> = {}): PrinterPlates {
  return {
    printer_id: id,
    applicable: true,
    disabled: false,
    capacity: null,
    effective_capacity: 10,
    counted: true,
    plates: 7,
    in_use: 0,
    available: 7,
    held: false,
    updated_at: null,
    updated_by: null,
    ...extra,
  };
}

let overview: { enabled: boolean; default_capacity: number; plate_clear_setting: boolean; printers: PrinterPlates[] };
const posts: { path: string; body: unknown }[] = [];

beforeEach(() => {
  permissions.granted = ['printers:read', 'printers:update', 'printers:clear_plate', 'settings:update'];
  posts.length = 0;
  overview = { enabled: true, default_capacity: 10, plate_clear_setting: false, printers: [entry(1)] };
  server.use(
    http.get(`${BASE}/printers/plates`, () => HttpResponse.json(overview)),
    http.post(`${BASE}/printers/:id/plates`, async ({ request, params }) => {
      posts.push({ path: `/printers/${params.id}/plates`, body: await request.json() });
      return HttpResponse.json({ updated: [Number(params.id)] });
    }),
    http.post(`${BASE}/printers/plates/set`, async ({ request }) => {
      const body = (await request.json()) as { printer_ids: number[] };
      posts.push({ path: '/printers/plates/set', body });
      return HttpResponse.json({ updated: body.printer_ids, skipped: [] });
    }),
    http.post(`${BASE}/printers/plates/config`, async ({ request }) => {
      const body = (await request.json()) as { printer_ids: number[] };
      posts.push({ path: '/printers/plates/config', body });
      return HttpResponse.json({ updated: body.printer_ids });
    }),
  );
});

afterEach(() => cleanup());

describe('helpers', () => {
  it('is a tab of the Enhanced Settings page', () => {
    expect(enhancedSettingsSections.map((s) => s.id)).toContain('plate-count');
  });

  it('reads the settings with defaults', () => {
    expect(normalizePlateCount(null)).toEqual({ enabled: false, default_capacity: 10 });
    expect(normalizePlateCount({ enabled: true, default_capacity: 0 })).toEqual({ enabled: true, default_capacity: 10 });
    expect(normalizePlateCount({ enabled: true, default_capacity: 8 })).toEqual({ enabled: true, default_capacity: 8 });
  });

  it('colours the count', () => {
    expect(plateLevel(entry(1, { held: true, available: 0 }))).toBe('held');
    expect(plateLevel(entry(1, { available: 2 }))).toBe('low');
    expect(plateLevel(entry(1, { available: 3 }))).toBe('ok');
  });
});

describe('printer card', () => {
  function renderPage() {
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([printer(1, 'A1-01')])),
      http.get('/api/v1/printers/:id/status', () =>
        HttpResponse.json({ connected: true, state: 'IDLE', temperatures: {}, vt_tray: [], ams: [] }),
      ),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
      http.get(`${BASE}/printers/intake-stops`, () => HttpResponse.json([])),
    );
    return render(<PrintersPage />);
  }

  it('refills to full with one tap on the count', async () => {
    renderPage();
    const badge = await screen.findByTestId('hyyz17200-plate-badge');
    expect(badge.textContent).toBe('7/10');

    fireEvent.click(badge);

    await waitFor(() => expect(posts).toEqual([{ path: '/printers/1/plates', body: { plates: null } }]));
  });

  it('shows red with no plate left, and nothing on a printer not counted', async () => {
    overview.printers = [entry(1, { plates: 1, in_use: 1, available: 0, held: true })];
    const view = renderPage();
    const badge = await screen.findByTestId('hyyz17200-plate-badge');
    expect(badge.className).toContain('red');
    expect(badge.textContent).toBe('1/10');
    view.unmount();

    overview.printers = [entry(1, { applicable: false, counted: false, plates: null, available: null })];
    renderPage();
    await waitFor(() => expect(document.getElementById('printer-card-1')).not.toBeNull());
    expect(screen.queryByTestId('hyyz17200-plate-badge')).toBeNull();
  });

  it('cannot refill a full stack', async () => {
    overview.printers = [entry(1, { plates: 10, available: 10 })];
    renderPage();
    const badge = await screen.findByTestId('hyyz17200-plate-badge');
    expect(badge.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(badge);
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toEqual([]);
  });

  it('sets a number from the card menu', async () => {
    renderPage();
    await screen.findByTestId('hyyz17200-plate-badge');
    const card = document.getElementById('printer-card-1') as HTMLElement;
    const menu = card.querySelector('.lucide-ellipsis-vertical, .lucide-more-vertical')?.closest('button');
    fireEvent.click(menu as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Set plate count…' }));

    const input = await screen.findByRole('spinbutton', { name: 'Clean plates' });
    expect((input as HTMLInputElement).value).toBe('7');
    fireEvent.change(input, { target: { value: '11' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(posts).toEqual([{ path: '/printers/1/plates', body: { plates: 4 } }]));
  });
});

describe('multi-select toolbar', () => {
  it('refills the counted printers with the number typed in', async () => {
    overview.printers = [entry(1), entry(2), entry(3, { applicable: false, counted: false, plates: null })];
    const user = userEvent.setup();
    render(
      <Hyyz17200BulkActions
        selectedIds={new Set([1, 2, 3])}
        printers={[printer(1, 'A1-01'), printer(2, 'A1-02'), printer(3, 'P1-01', 'P1S')]}
        disabled={false}
      />,
    );

    const button = await screen.findByRole('button', { name: 'Refill plates' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    const dialog = (await screen.findByText('Refill plates on 2 printers')).closest('div') as HTMLElement;
    const input = await screen.findByRole('spinbutton', { name: 'Plates' });
    expect((input as HTMLInputElement).value).toBe('10');
    expect(screen.getByText('1 printer without a plate count is skipped.')).toBeTruthy();
    await user.clear(input);
    await user.type(input, '6');
    await user.click(screen.getByRole('button', { name: 'Set 6 plates' }));

    await waitFor(() =>
      expect(posts).toEqual([{ path: '/printers/plates/set', body: { printer_ids: [1, 2], plates: 6 } }]),
    );
    expect(dialog).toBeTruthy();
  });

  it('is not offered while the feature is off', async () => {
    overview.enabled = false;
    render(<Hyyz17200BulkActions selectedIds={new Set([1])} printers={[printer(1, 'A1-01')]} disabled={false} />);
    await screen.findByRole('button', { name: /CSV/i });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: 'Refill plates' })).toBeNull();
  });
});

describe('Enhanced Settings tab', () => {
  let stored: { enabled: boolean; default_capacity: number };

  beforeEach(() => {
    stored = { enabled: false, default_capacity: 10 };
    server.use(
      http.get(`${BASE}/settings`, () => HttpResponse.json({ plate_count: stored })),
      http.put(`${BASE}/settings/plate_count`, async ({ request }) => {
        stored = (await request.json()) as typeof stored;
        return HttpResponse.json(stored);
      }),
      http.get('/api/v1/printers/', () => HttpResponse.json([printer(1, 'A1-01'), printer(2, 'P1-01', 'P1S')])),
    );
    overview.printers = [entry(1), entry(2, { applicable: false, counted: false, plates: null, available: null })];
  });

  it('saves the switch and the default capacity', async () => {
    const user = userEvent.setup();
    render(<PlateCountSection />);

    await user.click(await screen.findByRole('switch'));
    const capacity = screen.getByRole('spinbutton', { name: 'Plates in a full stack' });
    await user.clear(capacity);
    await user.type(capacity, '8');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(stored).toEqual({ enabled: true, default_capacity: 8 }));
  });

  it('switches a printer off, and leaves a printer cleared by hand alone', async () => {
    render(<PlateCountSection />);

    expect(await screen.findByText('Plate-clear confirmation applies: not counted')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Count plates on P1-01' })).toBeNull();
    const row = (await screen.findByText('A1-01')).closest('tr') as HTMLElement;
    expect(within(row).getByText('7/10')).toBeTruthy();

    fireEvent.change(within(row).getByRole('combobox', { name: 'Count plates on A1-01' }), {
      target: { value: 'off' },
    });

    await waitFor(() =>
      expect(posts).toEqual([{ path: '/printers/plates/config', body: { printer_ids: [1], disabled: true } }]),
    );
  });

  it('sets a printer its own capacity', async () => {
    render(<PlateCountSection />);
    const input = await screen.findByRole('spinbutton', { name: 'Capacity of A1-01 (empty: the default)' });

    fireEvent.change(input, { target: { value: '6' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(posts).toEqual([{ path: '/printers/plates/config', body: { printer_ids: [1], capacity: 6 } }]),
    );
  });
});
