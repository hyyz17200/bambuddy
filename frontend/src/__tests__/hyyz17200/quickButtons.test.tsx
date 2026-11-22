import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as rawRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { Layout } from '../../components/Layout';
import { Hyyz17200FloatingSelect, Hyyz17200HeaderSelect } from '../../hyyz17200/quickButtons/QuickButtons';
import { QuickButtonsSection } from '../../hyyz17200/quickButtons/QuickButtonsSection';
import {
  applyQuickButtons,
  normalizeQuickButtons,
  type QuickButtonSettings,
} from '../../hyyz17200/quickButtons/quickButtonsSettings';
import { useHyyz17200SelectToggle } from '../../hyyz17200/quickButtons/selectToggle';
import { enhancedSettingsSections } from '../../hyyz17200/settingsSections';

const URL = '/api/v1/hyyz17200/settings';

function stubViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      return {
        matches: max ? width <= Number(max[1]) : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      };
    },
  });
}

/** Stands in for PrintersPage: lends a Select toggle like its one-line mount. */
function Lender({ active, onToggle, available = true }: { active: boolean; onToggle: () => void; available?: boolean }) {
  useHyyz17200SelectToggle(active, onToggle, available);
  return null;
}

const originalWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  applyQuickButtons({ hide_bug_report: false, select_button: true });
  stubViewport(1600);
});

afterEach(() => {
  cleanup();
  applyQuickButtons(null);
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: originalWidth });
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
});

const floating = () => document.querySelector('[data-hyyz17200="floating-select"]');
const header = () => document.querySelector('[data-hyyz17200="header-select"]');

describe('quick buttons settings', () => {
  it('is a tab of the Enhanced Settings page', () => {
    expect(enhancedSettingsSections.map((section) => section.id)).toContain('quick-buttons');
  });

  it('is upstream unless saved otherwise', () => {
    expect(normalizeQuickButtons(null)).toEqual({ hide_bug_report: false, select_button: false });
    expect(normalizeQuickButtons({ hide_bug_report: 'yes', select_button: true })).toEqual({
      hide_bug_report: false,
      select_button: true,
    });
  });

  it('saves both switches', async () => {
    let stored: QuickButtonSettings = { hide_bug_report: false, select_button: false };
    const saved = vi.fn();
    server.use(
      http.get(URL, () => HttpResponse.json({ quick_buttons: stored })),
      http.put(`${URL}/quick_buttons`, async ({ request }) => {
        stored = (await request.json()) as QuickButtonSettings;
        saved(stored);
        return HttpResponse.json(stored);
      }),
    );
    const user = userEvent.setup();
    render(<QuickButtonsSection />);

    const [selectSwitch, bugSwitch] = await screen.findAllByRole('switch');
    await user.click(selectSwitch);
    await user.click(bugSwitch);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith({ hide_bug_report: true, select_button: true }));
  });
});

describe('floating Select button (PC)', () => {
  it('shows only while the printer page lends its toggle', () => {
    const { rerender } = rawRender(<Hyyz17200FloatingSelect />);
    expect(floating()).toBeNull();

    const onToggle = vi.fn();
    rerender(
      <>
        <Lender active={false} onToggle={onToggle} />
        <Hyyz17200FloatingSelect />
      </>,
    );
    fireEvent.click(floating()!);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <>
        <Lender active={false} onToggle={onToggle} available={false} />
        <Hyyz17200FloatingSelect />
      </>,
    );
    expect(floating()).toBeNull();
  });

  it('calls the latest toggle the page passed', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = rawRender(
      <>
        <Lender active={false} onToggle={first} />
        <Hyyz17200FloatingSelect />
      </>,
    );
    rerender(
      <>
        <Lender active={false} onToggle={second} />
        <Hyyz17200FloatingSelect />
      </>,
    );
    fireEvent.click(floating()!);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('hides while selecting, when switched off, and below the compact breakpoint', () => {
    const { rerender } = rawRender(
      <>
        <Lender active onToggle={() => {}} />
        <Hyyz17200FloatingSelect />
      </>,
    );
    expect(floating()).toBeNull();

    rerender(
      <>
        <Lender active={false} onToggle={() => {}} />
        <Hyyz17200FloatingSelect />
      </>,
    );
    expect(floating()).not.toBeNull();

    act(() => applyQuickButtons({ hide_bug_report: false, select_button: false }));
    expect(floating()).toBeNull();

    cleanup();
    act(() => applyQuickButtons({ hide_bug_report: false, select_button: true }));
    stubViewport(800);
    rawRender(
      <>
        <Lender active={false} onToggle={() => {}} />
        <Hyyz17200FloatingSelect />
      </>,
    );
    expect(floating()).toBeNull();
  });

  it('sits above the bug disc, or in its corner once the disc is hidden', () => {
    rawRender(
      <>
        <Lender active={false} onToggle={() => {}} />
        <Hyyz17200FloatingSelect />
      </>,
    );
    expect(floating()!.className).toContain('bottom-20');

    act(() => applyQuickButtons({ hide_bug_report: true, select_button: true }));
    expect(floating()!.className).toContain('bottom-4');
  });
});

describe('top bar Select button (phone)', () => {
  it('toggles and shows whether selection is on', () => {
    const onToggle = vi.fn();
    const { rerender } = rawRender(
      <>
        <Lender active={false} onToggle={onToggle} />
        <Hyyz17200HeaderSelect />
      </>,
    );
    expect(header()!.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(header()!);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <>
        <Lender active onToggle={onToggle} />
        <Hyyz17200HeaderSelect />
      </>,
    );
    expect(header()!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Layout mounts', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([])),
      http.get('/api/v1/version', () => HttpResponse.json({ version: '0.1.6', build: 'test' })),
      http.get('/api/v1/settings/', () => HttpResponse.json({ check_updates: false, check_printer_firmware: false })),
      http.get('/api/v1/external-links/', () => HttpResponse.json([])),
      http.get('/api/v1/smart-plugs/', () => HttpResponse.json([])),
      http.get('/api/v1/support/debug-logging', () => HttpResponse.json({ enabled: false })),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
      http.get('/api/v1/pending-uploads/count', () => HttpResponse.json({ count: 0 })),
      http.get('/api/v1/updates/check', () => HttpResponse.json({ update_available: false })),
      http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })),
      http.get('/api/v1/printers/developer-mode-warnings', () => HttpResponse.json([])),
      http.get('/api/v1/system/health', () => HttpResponse.json({ findings: [] })),
    );
  });

  const bugButtons = () => screen.queryAllByRole('button', { name: /bug|report/i });

  it('keeps the bug button on the phone top bar by default and drops it when hidden', async () => {
    stubViewport(800);
    render(
      <>
        <Lender active={false} onToggle={() => {}} />
        <Layout />
      </>,
    );
    await waitFor(() => expect(document.querySelector('header')).not.toBeNull());
    expect(bugButtons().length).toBeGreaterThan(0);
    expect(header()).not.toBeNull();

    act(() => applyQuickButtons({ hide_bug_report: true, select_button: true }));
    expect(bugButtons()).toHaveLength(0);
    expect(header()).not.toBeNull();
  });

  it('drops the PC corner disc when hidden', async () => {
    render(<Layout />);
    await waitFor(() => expect(bugButtons().length).toBeGreaterThan(0));

    act(() => applyQuickButtons({ hide_bug_report: true, select_button: true }));
    expect(bugButtons()).toHaveLength(0);
  });
});
