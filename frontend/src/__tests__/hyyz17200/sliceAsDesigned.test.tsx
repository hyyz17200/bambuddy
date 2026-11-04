/**
 * Batch "slice as designed" (hyyz17200): the file manager button that starts it
 * and the app-wide panel that follows it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const sliceApi = vi.hoisted(() => ({
  listSliceBatches: vi.fn(),
  startSliceBatch: vi.fn(),
  cancelSliceBatch: vi.fn(),
}));
vi.mock('../../hyyz17200/sliceAsDesigned/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hyyz17200/sliceAsDesigned/api')>();
  return { ...actual, ...sliceApi };
});

const permissions = { granted: [] as string[] };
vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({
      authEnabled: true,
      loading: false,
      user: { id: 1 },
      hasPermission: (p: string) => permissions.granted.includes(p),
    }),
  };
});

import { ToastProvider } from '../../contexts/ToastContext';
import { isProjectThreeMf, type SliceBatch, type SliceItem } from '../../hyyz17200/sliceAsDesigned/api';
import { SliceAsDesignedButton } from '../../hyyz17200/sliceAsDesigned/SliceAsDesignedButton';
import { SliceAsDesignedPanel } from '../../hyyz17200/sliceAsDesigned/SliceAsDesignedPanel';
import '../../i18n';

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>,
  );
  return qc;
}

const files = new Map(
  [
    { id: 1, filename: 'bracket.3mf', file_type: '3mf' },
    { id: 2, filename: 'hook.3mf', file_type: '3mf' },
    { id: 3, filename: 'cube.stl', file_type: 'stl' },
    { id: 4, filename: 'done.gcode.3mf', file_type: 'gcode.3mf' },
    // Sliced, but named .3mf: the type says so (#2993).
    { id: 5, filename: 'plate.3mf', file_type: 'gcode.3mf' },
  ].map((f) => [f.id, f]),
);

const item = (file_id: number, name: string, extra: Partial<SliceItem> = {}): SliceItem => ({
  file_id,
  name,
  status: 'pending',
  reason: null,
  detail: null,
  plate_count: 1,
  output_file_id: null,
  output_name: null,
  progress: null,
  ...extra,
});

const batch = (extra: Partial<SliceBatch>): SliceBatch => ({
  id: 1,
  status: 'running',
  created_at: '2026-11-04T10:00:00+00:00',
  finished_at: null,
  items: [],
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  permissions.granted = ['library:upload'];
  sliceApi.listSliceBatches.mockResolvedValue([]);
});

describe('isProjectThreeMf', () => {
  it('takes 3MF projects and leaves sliced files and other types out', () => {
    expect([...files.values()].filter(isProjectThreeMf).map((f) => f.id)).toEqual([1, 2]);
  });
});

describe('SliceAsDesignedButton', () => {
  it('is not shown when no 3MF project is selected', () => {
    wrap(<SliceAsDesignedButton selected={[3, 4, 5]} files={files} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('starts a batch with only the 3MF projects after confirming', async () => {
    sliceApi.startSliceBatch.mockResolvedValue(batch({}));
    wrap(<SliceAsDesignedButton selected={[3, 1, 4, 2]} files={files} />);

    await userEvent.click(screen.getByRole('button', { name: 'Slice as designed (2)' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('bracket.3mf')).toBeInTheDocument();
    expect(within(dialog).queryByText('cube.stl')).toBeNull();
    expect(within(dialog).getByText(/2 other selected files are not 3MF projects/)).toBeInTheDocument();
    expect(sliceApi.startSliceBatch).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Slice 2 files' }));

    await waitFor(() => expect(sliceApi.startSliceBatch).toHaveBeenCalledWith([1, 2]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('is disabled without permission to slice', () => {
    permissions.granted = [];
    wrap(<SliceAsDesignedButton selected={[1]} files={files} />);
    expect(screen.getByRole('button', { name: 'Slice as designed (1)' })).toBeDisabled();
  });
});

describe('SliceAsDesignedPanel', () => {
  it('shows nothing when there is no batch', async () => {
    wrap(<SliceAsDesignedPanel />);
    await waitFor(() => expect(sliceApi.listSliceBatches).toHaveBeenCalled());
    expect(screen.queryByText('Slice as designed')).toBeNull();
  });

  it('shows the running file, its progress and a way to stop', async () => {
    sliceApi.listSliceBatches.mockResolvedValue([
      batch({
        items: [
          item(1, 'bracket.3mf', { status: 'done' }),
          item(2, 'hook.3mf', { status: 'running', progress: { stage: 'Generating G-code', total_percent: 75 } }),
          item(3, 'cube.stl', { status: 'skipped', reason: 'not_3mf' }),
          item(6, 'gear.3mf'),
        ],
      }),
    ]);
    sliceApi.cancelSliceBatch.mockResolvedValue(batch({ status: 'cancelled' }));
    wrap(<SliceAsDesignedPanel />);

    expect(await screen.findByText('1 of 3 files')).toBeInTheDocument();
    expect(screen.getByText(/Now: hook\.3mf · Generating G-code 75%/)).toBeInTheDocument();
    expect(screen.getByText('1 skipped')).toBeInTheDocument();
    // Running: it can't be closed, only stopped.
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Stop after this file' }));
    await waitFor(() => expect(sliceApi.cancelSliceBatch).toHaveBeenCalledWith(1));
  });

  it('sums up a finished batch with the reasons, and stays closed once closed', async () => {
    const finished = batch({
      status: 'finished',
      finished_at: '2026-11-04T10:05:00+00:00',
      items: [
        item(1, 'bracket.3mf', { status: 'done', output_name: 'bracket.gcode.3mf' }),
        item(2, 'hook.3mf', { status: 'failed', detail: 'Object is off the bed' }),
        item(7, 'mesh.3mf', { status: 'skipped', reason: 'no_settings' }),
      ],
    });
    sliceApi.listSliceBatches.mockResolvedValue([finished]);
    wrap(<SliceAsDesignedPanel />);

    expect(await screen.findByText('Finished: 1 sliced')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Object is off the bed')).toBeInTheDocument();
    expect(screen.getByText(/No slicer settings saved in the file/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Finished: 1 sliced')).toBeNull();
    expect(localStorage.setItem).toHaveBeenCalledWith(
      'hyyz17200.sliceAsDesigned.dismissed',
      JSON.stringify(['1@2026-11-04T10:00:00+00:00']),
    );
  });
});
