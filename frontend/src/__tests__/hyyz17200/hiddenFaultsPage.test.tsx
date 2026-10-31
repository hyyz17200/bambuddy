import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { filterKnownHMSErrors } from '../../components/HMSErrorModal';
import { HiddenFaultsPage } from '../../hyyz17200/HiddenFaultsPage';
import { HiddenFaultsSync } from '../../hyyz17200/HiddenFaultsSync';
import { setHiddenCodes } from '../../hyyz17200/hiddenFaults';
import type { HiddenFault } from '../../hyyz17200/hiddenFaultsApi';
import type { HMSError } from '../../api/client';

const URL = '/api/v1/hyyz17200/hidden-faults';
const BMCU_A = '0500040000010044';

let stored: HiddenFault[] = [];
const added = vi.fn();
const removed = vi.fn();

beforeEach(() => {
  stored = [];
  added.mockClear();
  removed.mockClear();
  server.use(
    http.get(URL, () => HttpResponse.json(stored)),
    http.post(URL, async ({ request }) => {
      const fault = (await request.json()) as HiddenFault;
      added(fault);
      stored = [...stored, fault];
      return HttpResponse.json(fault);
    }),
    http.delete(`${URL}/:code`, ({ params }) => {
      removed(params.code);
      stored = stored.filter((fault) => fault.code !== params.code);
      return new HttpResponse(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  setHiddenCodes([]);
  cleanup();
});

describe('HiddenFaultsPage', () => {
  it('normalizes a typed code before saving it', async () => {
    const user = userEvent.setup();
    render(<HiddenFaultsPage />);

    await user.type(screen.getByLabelText('Fault code'), '0500_0400-0001 0044');
    await user.click(screen.getByRole('button', { name: 'Hide code' }));

    await waitFor(() => expect(added).toHaveBeenCalledWith({ code: BMCU_A, note: '' }));
    expect(await screen.findByText('0500-0400-0001-0044')).toBeTruthy();
  });

  it('refuses an invalid code', async () => {
    const user = userEvent.setup();
    render(<HiddenFaultsPage />);

    await user.type(screen.getByLabelText('Fault code'), '0500');

    expect(screen.getByText(/8 or 16 hexadecimal digits/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Hide code' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns before hiding a print error', async () => {
    const user = userEvent.setup();
    render(<HiddenFaultsPage />);

    await user.type(screen.getByLabelText('Fault code'), '0500-4004');

    expect(screen.getByText(/real failed or refused print/)).toBeTruthy();
  });

  it('offers the BMCU codes, which leave print errors alone, until they are all listed', async () => {
    const user = userEvent.setup();
    render(<HiddenFaultsPage />);

    await user.click(await screen.findByRole('button', { name: /BMCU/ }));

    await waitFor(() => expect(added).toHaveBeenCalledTimes(5));
    expect(stored.map((fault) => fault.code)).toEqual([
      '0500040000010044',
      '0501040000010044',
      '0502040000010044',
      '0503040000010044',
      '0510040000010044',
    ]);
    await waitFor(() => expect(screen.queryByRole('button', { name: /BMCU/ })).toBeNull());
  });

  it('removes a code', async () => {
    stored = [{ code: BMCU_A, note: 'BMCU' }];
    const user = userEvent.setup();
    render(<HiddenFaultsPage />);

    await user.click(await screen.findByRole('button', { name: /Stop hiding/ }));

    await waitFor(() => expect(removed).toHaveBeenCalledWith(BMCU_A));
  });
});

describe('HiddenFaultsSync', () => {
  const status = {
    hms_errors: [
      { code: '0x0', attr: 0, module: 5, severity: 1, full_code: BMCU_A, description: 'AMS firmware' } as HMSError,
    ],
  };

  function Badge() {
    const { data } = useQuery({ queryKey: ['printerStatus', 1], enabled: false, initialData: status });
    return <span data-testid="count">{filterKnownHMSErrors(data.hms_errors).length}</span>;
  }

  it('redraws a printer view holding unchanged status once the codes arrive', async () => {
    stored = [{ code: BMCU_A, note: '' }];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <Badge />
        <HiddenFaultsSync />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('count').textContent).toBe('1');
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('0'));
  });
});
