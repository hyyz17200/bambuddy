import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as plainRender, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import { render } from '../utils';
import { ConfigureAmsSlotModal } from '../../components/ConfigureAmsSlotModal';
import { Hyyz17200RgbInputs } from '../../hyyz17200/RgbInputs';

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

const amsProps = {
  isOpen: true,
  onClose: vi.fn(),
  printerId: 1,
  slotInfo: { amsId: 0, trayId: 0, trayType: 'PLA', trayColor: 'FF0000FF', traySubBrands: 'PLA Basic' },
  nozzleDiameter: '0.4',
  onSuccess: vi.fn(),
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => cleanup());

describe('the AMS slot dialog', () => {
  it('shows the color as RGB and takes it back from RGB', async () => {
    render(<ConfigureAmsSlotModal {...amsProps} />);
    const red = await screen.findByLabelText('Red (0–255)');
    expect(red).toHaveValue('255');
    expect(screen.getByLabelText('Green (0–255)')).toHaveValue('0');

    fireEvent.change(screen.getByLabelText('Blue (0–255)'), { target: { value: '128' } });

    expect(screen.getByText('Hex: #FF0080', { exact: false })).toBeInTheDocument();
    expect(screen.getByDisplayValue('FF0080')).toBeInTheDocument();

    fireEvent.click(await screen.findByTitle('White'));
    expect(screen.getByLabelText('Blue (0–255)')).toHaveValue('255');
  });
});

describe('Hyyz17200RgbInputs', () => {
  function renderRgb(hex: string) {
    const onChange = vi.fn();
    const view = plainRender(
      <I18nextProvider i18n={i18n}>
        <Hyyz17200RgbInputs hex={hex} placeholderHex="102030FF" onChange={onChange} />
      </I18nextProvider>,
    );
    const rerender = (next: string) =>
      view.rerender(
        <I18nextProvider i18n={i18n}>
          <Hyyz17200RgbInputs hex={next} placeholderHex="102030FF" onChange={onChange} />
        </I18nextProvider>,
      );
    const boxes = ['Red', 'Green', 'Blue'].map((c) => screen.getByLabelText(`${c} (0–255)`));
    return { onChange, rerender, boxes };
  }

  it('follows the hex, and empties with it, hinting the shown color', () => {
    const { rerender, boxes } = renderRgb('0A80FF');
    expect(boxes.map((b) => (b as HTMLInputElement).value)).toEqual(['10', '128', '255']);

    rerender('');
    expect(boxes.map((b) => (b as HTMLInputElement).value)).toEqual(['', '', '']);
    expect(boxes.map((b) => b.getAttribute('placeholder'))).toEqual(['16', '32', '48']);

    rerender('half'); // not a hex yet: the boxes stay as they are
    expect((boxes[0] as HTMLInputElement).value).toBe('');
  });

  it('reports only a complete color, clamping to 255', () => {
    const { onChange, boxes } = renderRgb('');

    fireEvent.change(boxes[0], { target: { value: '300' } });
    expect(boxes[0]).toHaveValue('255');
    fireEvent.change(boxes[1], { target: { value: '1a6' } });
    expect(boxes[1]).toHaveValue('16');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(boxes[2], { target: { value: '0' } });
    expect(onChange).toHaveBeenLastCalledWith('FF1000');
  });

  it('leaves the color alone while a box is retyped', () => {
    const { onChange, boxes } = renderRgb('FF0000');

    fireEvent.change(boxes[0], { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(boxes[0]).toHaveValue('');

    fireEvent.change(boxes[0], { target: { value: '12' } });
    expect(onChange).toHaveBeenLastCalledWith('0C0000');
  });
});
