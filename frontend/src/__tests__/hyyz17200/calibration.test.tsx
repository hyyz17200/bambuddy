/**
 * Batch calibration (hyyz17200): the toolbar's start dialog, the progress
 * window, and the text for each printer's place in the batch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import type { Printer } from '../../api/client';
import { server } from '../mocks/server';

const intake = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('../../hyyz17200/printerIntakeApi', () => ({
  INTAKE_STOPS_QUERY_KEY: ['hyyz17200', 'intake-stops'],
  listIntakeStops: vi.fn(async () => []),
  setPrinterIntake: intake.set,
}));

const permissions = { granted: [] as string[] };
vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => ({ hasPermission: (p: string) => permissions.granted.includes(p) }) };
});

import { ToastProvider } from '../../contexts/ToastContext';
import { Hyyz17200BulkActions } from '../../hyyz17200/bulkActions/BulkActions';
import { byLocation } from '../../hyyz17200/bulkActions/batchText';
import type { CalibrationBatch, CalibrationItem, CalibrationPreview } from '../../hyyz17200/calibrationApi';
import { statusText, stepsText } from '../../hyyz17200/calibration/calibrationText';
import { useCalibrationCard } from '../../hyyz17200/calibration/useCalibrationCard';
import { hyyz17200Request, Hyyz17200RequestError } from '../../hyyz17200/request';
import i18n from '../../i18n';

const tr = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const K = 'hyyz17200.calibration';

const printer = (id: number, extra: Partial<Printer> = {}) =>
  ({ id, name: `P${id}`, model: 'A1', is_active: true, location: null, ...extra }) as unknown as Printer;

const item = (printer_id: number, extra: Partial<CalibrationItem> = {}): CalibrationItem => ({
  printer_id,
  name: `P${printer_id}`,
  status: 'waiting',
  detail: null,
  blocker: null,
  option: null,
  motor_noise_skipped: false,
  stage: null,
  started_at: null,
  finished_at: null,
  ...extra,
});

const batchOf = (items: CalibrationItem[], status: CalibrationBatch['status'] = 'running'): CalibrationBatch => ({
  id: 1,
  status,
  created_at: '2026-11-03T10:00:00',
  created_by: 'operator',
  finished_at: null,
  bed_leveling: true,
  vibration: true,
  motor_noise: true,
  resume_intake: true,
  items,
});

let current: CalibrationBatch | null;
let preview: CalibrationPreview;
let started: unknown[];
let cancelled: number;
let startError: { status: number; detail: string } | null;

beforeEach(() => {
  permissions.granted = ['printers:read', 'printers:update', 'printers:control'];
  current = null;
  started = [];
  cancelled = 0;
  startError = null;
  preview = { kill_switch: false, batch_running: false, printers: [] };
  server.use(
    http.get('/api/v1/hyyz17200/calibration/batch', () => HttpResponse.json(current)),
    http.post('/api/v1/hyyz17200/calibration/preview', () => HttpResponse.json(preview)),
    http.post('/api/v1/hyyz17200/calibration/batch', async ({ request }) => {
      const body = (await request.json()) as { printer_ids: number[] };
      started.push(body);
      if (startError) return HttpResponse.json({ detail: startError.detail }, { status: startError.status });
      current = batchOf(body.printer_ids.map((id) => item(id)));
      return HttpResponse.json(current);
    }),
    http.post('/api/v1/hyyz17200/calibration/batch/cancel', () => {
      cancelled += 1;
      if (current) current = { ...current, status: 'cancelled', items: current.items.map((i) => ({ ...i, status: 'cancelled' })) };
      return HttpResponse.json({ cancelled: true });
    }),
  );
});

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

function toolbar(printers: Printer[]) {
  render(wrap(<Hyyz17200BulkActions selectedIds={new Set(printers.map((p) => p.id))} printers={printers} disabled={false} />));
}

const dialog = () => screen.getByRole('dialog');

describe('starting a batch', () => {
  it('lists what each printer will run, needs the beds confirmed empty, and sends the order and options', async () => {
    const user = userEvent.setup();
    preview.printers = [
      { printer_id: 2, name: 'P2', model: 'P1S', motor_noise: true, blocker: null },
      { printer_id: 1, name: 'P1', model: 'A1', motor_noise: false, blocker: 'offline' },
    ];
    toolbar([printer(1, { location: 'Shelf B' }), printer(2, { location: 'Shelf A' }), printer(3, { is_active: false })]);

    await user.click(screen.getByRole('button', { name: tr(`${K}.button`) }));
    const box = within(dialog());
    await box.findByText('P2');
    const steps = [tr(`${K}.bedLeveling`), tr(`${K}.vibration`)].join(tr(`${K}.separator`));
    expect(box.getByText(`${steps}${tr(`${K}.separator`)}${tr(`${K}.motorNoise`)}`)).toBeInTheDocument();
    expect(box.getByText(`${steps} · ${tr(`${K}.motorNoiseNotReported`)}`)).toBeInTheDocument();
    expect(box.getByText(tr(`${K}.waitsFor`, { reason: tr(`${K}.blocker.offline`) }))).toBeInTheDocument();
    expect(box.getByText(tr(`${K}.leftOutMaintenance`, { names: 'P3' }))).toBeInTheDocument();

    const startButton = box.getByRole('button', { name: tr(`${K}.start`, { count: 2 }) });
    expect(startButton).toBeDisabled();
    await user.click(box.getByRole('checkbox', { name: new RegExp(tr(`${K}.vibration`)) }));
    await user.click(box.getByRole('checkbox', { name: new RegExp(tr(`${K}.bedClear`)) }));
    expect(startButton).toBeEnabled();
    await user.click(startButton);

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toEqual({
      printer_ids: [2, 1],
      bed_leveling: true,
      vibration: false,
      motor_noise: true,
      resume_intake: true,
    });
    // Then the progress window.
    expect(await screen.findByText(tr(`${K}.summaryRunning`, { done: 0, total: 2 }))).toBeInTheDocument();
  });

  it('cannot start while the kill switch is on', async () => {
    const user = userEvent.setup();
    preview = { kill_switch: true, batch_running: false, printers: [{ printer_id: 1, name: 'P1', model: 'A1', motor_noise: true, blocker: null }] };
    toolbar([printer(1)]);

    await user.click(screen.getByRole('button', { name: tr(`${K}.button`) }));
    const box = within(dialog());
    expect(await box.findByText(tr(`${K}.error.kill_switch`))).toBeInTheDocument();
    await user.click(box.getByRole('checkbox', { name: new RegExp(tr(`${K}.bedClear`)) }));
    expect(box.getByRole('button', { name: tr(`${K}.start`, { count: 1 }) })).toBeDisabled();
  });

  it("shows the server's reason when it refuses", async () => {
    const user = userEvent.setup();
    startError = { status: 409, detail: 'batch_running' };
    preview.printers = [{ printer_id: 1, name: 'P1', model: 'A1', motor_noise: true, blocker: null }];
    toolbar([printer(1)]);

    await user.click(screen.getByRole('button', { name: tr(`${K}.button`) }));
    const box = within(dialog());
    await box.findByText('P1');
    await user.click(box.getByRole('checkbox', { name: new RegExp(tr(`${K}.bedClear`)) }));
    await user.click(box.getByRole('button', { name: tr(`${K}.start`, { count: 1 }) }));

    expect(await screen.findByText(tr(`${K}.error.batch_running`))).toBeInTheDocument();
  });

  it('needs printers:control and printers:update', () => {
    permissions.granted = ['printers:read', 'printers:update'];
    toolbar([printer(1)]);
    expect(screen.getByRole('button', { name: tr(`${K}.button`) })).toBeDisabled();
  });
});

describe('progress', () => {
  it('the toolbar button shows a running batch and opens it; the rest can be cancelled', async () => {
    const user = userEvent.setup();
    current = batchOf([
      item(1, { status: 'succeeded', option: 6, motor_noise_skipped: true, started_at: '2026-11-03T10:00:00', finished_at: '2026-11-03T10:12:00' }),
      item(2, { status: 'running', option: 14, stage: 'Vibration compensation', started_at: '2026-11-03T10:13:00' }),
      item(3, { status: 'waiting', blocker: 'plate_clear' }),
    ]);
    toolbar([printer(1)]);

    await user.click(await screen.findByRole('button', { name: tr(`${K}.progressButton`, { done: 1, total: 3 }) }));
    const box = within(dialog());
    expect(box.getByText(tr(`${K}.summaryRunning`, { done: 1, total: 3 }))).toBeInTheDocument();
    expect(box.getByText(`${tr(`${K}.status.running`)} · Vibration compensation`)).toBeInTheDocument();
    expect(box.getByText(tr(`${K}.blocker.plate_clear`))).toBeInTheDocument();
    expect(box.getByText(new RegExp(tr(`${K}.minutes`, { count: 12 })))).toBeInTheDocument();

    await user.click(box.getByRole('button', { name: tr(`${K}.cancel`) }));
    expect(box.getByText(tr(`${K}.cancelWarning`))).toBeInTheDocument();
    await user.click(box.getByRole('button', { name: tr(`${K}.cancelConfirm`) }));

    await waitFor(() => expect(cancelled).toBe(1));
    expect(await box.findByText(tr(`${K}.summaryCancelled`))).toBeInTheDocument();
  });
});

describe('card pill', () => {
  function Card({ id }: { id: number }) {
    const { pill } = useCalibrationCard(id);
    return <div data-testid="card">{pill}</div>;
  }

  it.each([
    ['waiting', `${K}.pillWaiting`],
    ['running', `${K}.pillRunning`],
    ['starting', `${K}.pillRunning`],
  ] as const)('%s', async (status, key) => {
    current = batchOf([item(1, { status })]);
    render(wrap(<Card id={1} />));
    expect(await screen.findByText(tr(key))).toBeInTheDocument();
  });

  it('nothing once done, or for a printer not in the batch, or after the batch', async () => {
    current = batchOf([item(1, { status: 'succeeded' }), item(2)]);
    render(wrap(<><Card id={1} /><Card id={3} /></>));
    await waitFor(() => expect(screen.getAllByTestId('card').every((c) => c.textContent === '')).toBe(true));

    current = batchOf([item(1)], 'cancelled');
    render(wrap(<Card id={1} />));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(tr(`${K}.pillWaiting`))).toBeNull();
  });
});

describe('text', () => {
  const t = i18n.t.bind(i18n) as never;

  it('names exactly the steps in the option', () => {
    expect(stepsText(t, 6)).toBe([tr(`${K}.bedLeveling`), tr(`${K}.vibration`)].join(tr(`${K}.separator`)));
    expect(stepsText(t, 8)).toBe(tr(`${K}.motorNoise`));
  });

  it('says why a printer failed or left', () => {
    expect(statusText(t, item(1, { status: 'failed', detail: 'not_started' }))).toBe(
      tr(`${K}.status.failed`, { reason: tr(`${K}.detail.not_started`) }),
    );
    expect(statusText(t, item(1, { status: 'cancelled', detail: 'intake_resumed' }))).toBe(tr(`${K}.detail.intake_resumed`));
    expect(statusText(t, item(1, { status: 'waiting' }))).toBe(tr(`${K}.status.waiting`));
  });

  it('orders by location, then name, unplaced last', () => {
    const list = [printer(10, { location: 'B' }), printer(2), printer(3, { location: 'A' }), printer(1, { location: 'B' })];
    expect(byLocation(list).map((p) => p.id)).toEqual([3, 1, 10, 2]);
  });
});

describe('request errors', () => {
  it("carry the API's detail", async () => {
    server.use(http.get('/api/v1/hyyz17200/nope', () => HttpResponse.json({ detail: 'kill_switch' }, { status: 409 })));
    const error = await hyyz17200Request('/nope').catch((e) => e);
    expect(error).toBeInstanceOf(Hyyz17200RequestError);
    expect(error.message).toBe('HTTP 409');
    expect(error.detail).toBe('kill_switch');
  });
});
