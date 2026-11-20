import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PlateClearSection } from '../../hyyz17200/PlateClearSection';
import { choiceOf, overrideOf, plateClearApplies } from '../../hyyz17200/plateClear';

type Row = { id: number; name: string; model: string | null; location: string | null; require_plate_clear: boolean | null };

let printers: Row[];
let appSetting: boolean;
let printerPatches: { id: number; body: Record<string, unknown> }[];
let settingPuts: Record<string, unknown>[];

beforeEach(() => {
  printers = [
    { id: 1, name: 'A1-01', model: 'A1', location: 'Shelf A', require_plate_clear: false },
    { id: 2, name: 'A1-02', model: 'A1', location: 'Shelf A', require_plate_clear: null },
    { id: 3, name: 'P1-01', model: 'P1S', location: 'Shelf B', require_plate_clear: true },
  ];
  appSetting = true;
  printerPatches = [];
  settingPuts = [];
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
    http.patch('/api/v1/printers/:id', async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      const id = Number(params.id);
      printerPatches.push({ id, body });
      printers = printers.map((p) => (p.id === id ? { ...p, ...body } : p));
      return HttpResponse.json(printers.find((p) => p.id === id));
    }),
    http.get('/api/v1/settings/', () => HttpResponse.json({ require_plate_clear: appSetting })),
    http.put('/api/v1/settings/', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      settingPuts.push(body);
      appSetting = Boolean(body.require_plate_clear);
      return HttpResponse.json({ require_plate_clear: appSetting });
    }),
  );
});

afterEach(cleanup);

describe('plate-clear helpers', () => {
  it('maps upstream values to choices and back', () => {
    expect(choiceOf(null)).toBe('follow');
    expect(choiceOf(true)).toBe('on');
    expect(choiceOf(false)).toBe('off');
    expect(overrideOf('follow')).toBeNull();
    expect(overrideOf('on')).toBe(true);
    expect(overrideOf('off')).toBe(false);
  });

  it('applies as upstream resolves it: the printer first, then the app setting', () => {
    expect(plateClearApplies(null, true)).toBe(true);
    expect(plateClearApplies(null, false)).toBe(false);
    expect(plateClearApplies(false, true)).toBe(false);
    expect(plateClearApplies(true, false)).toBe(true);
  });
});

describe('PlateClearSection', () => {
  it('shows each printer and whether the confirmation applies to it', async () => {
    render(<PlateClearSection />);

    const row = (await screen.findByText('A1-02')).closest('tr') as HTMLElement;
    expect(within(row).getByRole('combobox')).toHaveValue('follow');
    expect(within(row).getByText('Yes')).toBeInTheDocument();
    const off = screen.getByText('A1-01').closest('tr') as HTMLElement;
    expect(within(off).getByText('No')).toBeInTheDocument();
    expect(await screen.findByText('The confirmation applies to 2 of 3 printers.')).toBeInTheDocument();
  });

  it('sets the selected printers through upstream, skipping ones already set', async () => {
    const user = userEvent.setup();
    render(<PlateClearSection />);
    await screen.findByText('A1-01');

    await user.selectOptions(screen.getByLabelText('Model'), 'A1');
    expect(screen.queryByText('P1-01')).toBeNull();
    await user.click(screen.getByLabelText('Select all shown'));
    await user.click(screen.getByRole('button', { name: 'Off' }));

    await waitFor(() => expect(printerPatches).toEqual([{ id: 2, body: { require_plate_clear: false } }]));
    expect(await screen.findByText('Saved for 1 printers.')).toBeInTheDocument();
  });

  it('changes one printer from its row, back to following the app setting', async () => {
    const user = userEvent.setup();
    render(<PlateClearSection />);

    await user.selectOptions(await screen.findByLabelText('Own setting for P1-01'), 'follow');

    await waitFor(() => expect(printerPatches).toEqual([{ id: 3, body: { require_plate_clear: null } }]));
  });

  it('switches the app setting', async () => {
    const user = userEvent.setup();
    render(<PlateClearSection />);
    const box = await screen.findByRole('checkbox', { name: /app setting\)/ });
    await waitFor(() => expect(box).toBeChecked());

    await user.click(box);

    await waitFor(() => expect(settingPuts).toEqual([{ require_plate_clear: false }]));
  });
});
