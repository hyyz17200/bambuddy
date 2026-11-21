/**
 * Printer notes (hyyz17200): a marker beside the name in every card size,
 * the S card included, and a dialog with notes, things to do and a history
 * that includes upstream's maintenance resets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const permissions = {
  granted: [] as string[],
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
import type { PrinterNote, PrinterNoteSummary } from '../../hyyz17200/printerNotes/api';

const ALL = ['printers:read', 'maintenance:read', 'maintenance:create', 'maintenance:update', 'maintenance:delete'];

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

function note(id: number, kind: PrinterNote['kind'], body: string, at = '2026-11-01T10:00:00'): PrinterNote {
  return {
    id,
    printer_id: 1,
    kind,
    body,
    created_at: at,
    created_by: 'alice',
    edited_at: null,
    edited_by: null,
    resolved_at: kind === 'done' ? at : null,
    resolved_by: kind === 'done' ? 'alice' : null,
  };
}

// The test setup's localStorage is a set of no-op mocks; the card size lives here.
let stored: Record<string, string>;
let summaries: PrinterNoteSummary[];
let notes: PrinterNote[];
let summaryRequests: number;
let posts: unknown[];
let patches: { id: number; body: unknown }[];

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
    http.get('/api/v1/hyyz17200/printers/notes/summary', () => {
      summaryRequests += 1;
      return HttpResponse.json(summaries);
    }),
    http.get('/api/v1/hyyz17200/printers/1/notes', () => HttpResponse.json(notes)),
    http.post('/api/v1/hyyz17200/printers/1/notes', async ({ request }) => {
      const body = await request.json();
      posts.push(body);
      return HttpResponse.json(note(99, 'info', 'x'));
    }),
    http.patch('/api/v1/hyyz17200/printers/1/notes/:id', async ({ request, params }) => {
      patches.push({ id: Number(params.id), body: await request.json() });
      return HttpResponse.json(note(Number(params.id), 'done', 'x'));
    }),
    http.get('/api/v1/maintenance/printers/1/log', () =>
      HttpResponse.json({
        items: [
          {
            id: 7,
            printer_id: 1,
            printer_name: 'A1-01',
            maintenance_type_id: 1,
            maintenance_type_name: 'Lubricate rails',
            hours_at_maintenance: 120.5,
            notes: 'Used PTFE grease',
            performed_by_id: null,
            performed_by_username: 'bob',
            performed_at: '2026-10-01T09:00:00',
          },
        ],
        total: 1,
      }),
    ),
  );
  return render(<PrintersPage />);
}

async function card() {
  await waitFor(() => expect(document.getElementById('printer-card-1')).not.toBeNull());
  return document.getElementById('printer-card-1') as HTMLElement;
}

describe('printer notes', () => {
  beforeEach(() => {
    permissions.granted = [...ALL];
    summaries = [];
    notes = [];
    summaryRequests = 0;
    posts = [];
    patches = [];
    stored = { printerCardSize: '1' }; // S
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => stored[key] ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
      stored[key] = value;
    });
  });

  it('marks the S card with the count of things to do, and opens the notes from it', async () => {
    summaries = [{ printer_id: 1, todo_count: 2, info_count: 1, latest: 'Z axis squeaks' }];
    notes = [note(1, 'info', '0.6 nozzle fitted'), note(2, 'todo', 'Z axis squeaks'), note(3, 'todo', 'Belt worn')];
    renderPage();
    const c = await card();
    // Really the S card: its connection dot only exists there.
    await waitFor(() => expect(c.querySelector('[title="Connected"]')).not.toBeNull());

    const badge = await within(c).findByTestId('hyyz17200-note-badge');
    expect(badge.textContent).toBe('2');
    expect(badge.getAttribute('title')).toBe('Z axis squeaks');

    fireEvent.click(badge);
    const dialog = await screen.findByRole('dialog');
    // Outside the card: a sorted or dragged card carries a transform.
    expect(c.contains(dialog)).toBe(false);
    expect(await within(dialog).findByText('0.6 nozzle fitted')).toBeTruthy();
    expect(within(dialog).getByText('Belt worn')).toBeTruthy();

    // Neither the badge nor a click in the dialog opens the S card's detail view.
    fireEvent.click(within(dialog).getByText('0.6 nozzle fitted'));
    expect(stored.printerCardSize).toBe('1');
  });

  it('shows a plain marker without a number when there are only descriptions', async () => {
    summaries = [{ printer_id: 1, todo_count: 0, info_count: 1, latest: '0.6 nozzle fitted' }];
    renderPage();
    const badge = await within(await card()).findByTestId('hyyz17200-note-badge');
    expect(badge.textContent).toBe('');
    expect(badge.getAttribute('aria-label')).toBe('1 note');
  });

  it('shows no marker for a printer without notes', async () => {
    renderPage();
    const c = await card();
    await waitFor(() => expect(summaryRequests).toBeGreaterThan(0));
    expect(within(c).queryByTestId('hyyz17200-note-badge')).toBeNull();
  });

  it('does not ask for notes without maintenance:read', async () => {
    permissions.granted = ['printers:read'];
    summaries = [{ printer_id: 1, todo_count: 1, info_count: 0, latest: 'x' }];
    renderPage();
    const c = await card();
    expect(within(c).queryByTestId('hyyz17200-note-badge')).toBeNull();
    expect(summaryRequests).toBe(0);
  });

  it('adds a note of the chosen kind from the card menu', async () => {
    stored.printerCardSize = '2';
    renderPage();
    const c = await card();
    fireEvent.click(c.querySelector('.lucide-ellipsis-vertical, .lucide-more-vertical')?.closest('button') as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Notes…' }));
    const dialog = await screen.findByRole('dialog');

    // A description is the default kind.
    expect(within(dialog).getByRole('radio', { name: 'Note' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'To do' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'New note' }), {
      target: { value: '  Check the belt  ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(posts).toEqual([{ body: 'Check the belt', kind: 'todo' }]));
  });

  it('marks a thing to do done in one click, and changes kind through Edit', async () => {
    summaries = [{ printer_id: 1, todo_count: 1, info_count: 0, latest: 'Check fan' }];
    notes = [note(5, 'todo', 'Check fan')];
    renderPage();
    fireEvent.click(await within(await card()).findByTestId('hyyz17200-note-badge'));
    const dialog = await screen.findByRole('dialog');
    const row = await within(dialog).findByTestId('hyyz17200-note-5');

    fireEvent.click(within(row).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(patches).toEqual([{ id: 5, body: { kind: 'done' } }]));

    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(row).getByRole('textbox', { name: 'Note text' }), { target: { value: 'Fan is loud' } });
    fireEvent.click(within(row).getByRole('radio', { name: 'Note' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches[1]).toEqual({ id: 5, body: { body: 'Fan is loud', kind: 'info' } }));
  });

  it("puts upstream's maintenance resets in the history", async () => {
    summaries = [{ printer_id: 1, todo_count: 0, info_count: 0, latest: '' }];
    notes = [note(8, 'done', 'Replaced hotend fan', '2026-11-02T10:00:00')];
    renderPage();
    fireEvent.click(await within(await card()).findByTestId('hyyz17200-note-badge'));
    const dialog = await screen.findByRole('dialog');
    const history = await within(dialog).findByRole('region', { name: 'History' });

    await within(history).findByText('Maintenance: Lubricate rails');
    const items = within(history).getAllByRole('listitem').map((li) => li.textContent);
    // Newest first: the note (Nov 2) before the reset (Oct 1).
    expect(items[0]).toContain('Replaced hotend fan');
    expect(items[1]).toContain('Used PTFE grease');
  });
});
