import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as plainRender, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import i18n from '../../i18n';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ConfigureAmsSlotModal } from '../../components/ConfigureAmsSlotModal';
import { ColorSection } from '../../components/spool-form/ColorSection';
import { defaultFormData } from '../../components/spool-form/types';
import { QuickColorsSection } from '../../hyyz17200/QuickColorsSection';
import {
  QUICK_COLOR_DEFAULTS,
  applyQuickColors,
  normalizeQuickColors,
  type QuickColorSettings,
} from '../../hyyz17200/quickColors';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getCloudSettings: vi.fn().mockResolvedValue({ filament: [] }),
      getKProfiles: vi.fn().mockResolvedValue({ profiles: [] }),
      getSettings: vi.fn().mockResolvedValue({}),
      getSlicerPrinterModels: vi.fn().mockResolvedValue({}),
      getLocalPresets: vi.fn().mockResolvedValue({ filament: [] }),
      getBuiltinFilaments: vi.fn().mockResolvedValue([]),
      orcaCloudListProfiles: vi.fn().mockResolvedValue({ filament: [], printer: [], process: [] }),
      searchColors: vi.fn().mockResolvedValue([]),
      getColorCatalog: vi.fn().mockResolvedValue([]),
      getPrinterStatus: vi.fn().mockResolvedValue({}),
    },
  };
});

const MINE: QuickColorSettings = {
  customized: true,
  basic: [
    { name: 'Bamboo', hex: 'A1B2C3' },
    { name: 'Ink', hex: '112233' },
  ],
  extended: [{ name: 'Rust', hex: 'B7410E' }],
};

const amsProps = {
  isOpen: true,
  onClose: vi.fn(),
  printerId: 1,
  slotInfo: { amsId: 0, trayId: 0, trayType: 'PLA', trayColor: 'FF0000FF', traySubBrands: 'PLA Basic' },
  nozzleDiameter: '0.4',
  onSuccess: vi.fn(),
};

function renderColorSection() {
  const updateField = vi.fn();
  plainRender(
    <I18nextProvider i18n={i18n}>
      <ColorSection
        formData={defaultFormData}
        updateField={updateField}
        recentColors={[]}
        onColorUsed={vi.fn()}
        catalogColors={[]}
      />
    </I18nextProvider>,
  );
  return updateField;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  act(() => applyQuickColors(QUICK_COLOR_DEFAULTS));
  cleanup();
});

describe('normalizeQuickColors', () => {
  it('turns anything malformed back into upstream', () => {
    expect(normalizeQuickColors(undefined).customized).toBe(false);
    expect(normalizeQuickColors({ ...MINE, basic: [{ name: 'x', hex: 'nope' }] }).customized).toBe(false);
    expect(normalizeQuickColors({ ...MINE, extended: 'x' }).customized).toBe(false);
    expect(normalizeQuickColors({ ...MINE, basic: [{ name: ' Ink ', hex: 'abcdef' }] }).basic).toEqual([
      { name: 'Ink', hex: 'ABCDEF' },
    ]);
  });
});

describe('the AMS slot dialog', () => {
  it("keeps upstream's swatches until colors are customized", async () => {
    render(<ConfigureAmsSlotModal {...amsProps} />);
    expect(await screen.findByTitle('White')).toBeInTheDocument();

    act(() => applyQuickColors(MINE));

    expect(await screen.findByTitle('Bamboo')).toBeInTheDocument();
    expect(screen.getByTitle('Ink')).toBeInTheDocument();
    expect(screen.queryByTitle('White')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Rust')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle(/show more colors/i));
    expect(screen.getByTitle('Rust')).toBeInTheDocument();
  });
});

describe('the spool form', () => {
  it('uses the custom colors and keeps its transparent Clear swatch', () => {
    act(() => applyQuickColors(MINE));
    const updateField = renderColorSection();

    expect(screen.getByTitle('Bamboo')).toBeInTheDocument();
    expect(screen.getByTitle('Clear')).toBeInTheDocument();
    expect(screen.queryByTitle('White')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Rust')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Bamboo'));
    expect(updateField).toHaveBeenCalledWith('rgba', 'A1B2C3FF');

    fireEvent.click(screen.getByText(/show all/i));
    expect(screen.getByTitle('Rust')).toBeInTheDocument();
  });

  it("keeps upstream's swatches when not customized", () => {
    renderColorSection();
    expect(screen.getByTitle('White')).toBeInTheDocument();
    expect(screen.getByTitle('Clear')).toBeInTheDocument();
  });
});

describe('QuickColorsSection', () => {
  const URL = '/api/v1/hyyz17200/settings';
  let stored: QuickColorSettings;
  const saved = vi.fn();

  beforeEach(() => {
    stored = QUICK_COLOR_DEFAULTS;
    saved.mockClear();
    server.use(
      http.get(URL, () => HttpResponse.json({ quick_colors: stored })),
      http.put(`${URL}/quick_colors`, async ({ request }) => {
        stored = (await request.json()) as QuickColorSettings;
        saved(stored);
        return HttpResponse.json(stored);
      }),
    );
  });

  it('saves edited colors, and refuses a hex that is already listed', async () => {
    const user = userEvent.setup();
    render(<QuickColorsSection />);
    const toggle = await screen.findByRole('switch');
    expect(screen.queryByRole('button', { name: /^add$/i })).not.toBeInTheDocument();

    await user.click(toggle);
    const first = screen.getByTestId('quick-color-basic-0');
    const [, name, hex] = first.querySelectorAll('input');
    await user.clear(name);
    await user.type(name, 'Bamboo');
    await user.clear(hex);
    await user.type(hex, '000000'); // Black's

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(screen.getByText(/each hex may appear only once/i)).toBeInTheDocument();

    await user.clear(hex);
    await user.type(hex, 'a1b2c3');
    await user.click(save);

    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(saved.mock.calls[0][0].customized).toBe(true);
    expect(saved.mock.calls[0][0].basic[0]).toEqual({ name: 'Bamboo', hex: 'A1B2C3' });
  });
});
