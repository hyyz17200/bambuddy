import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { render } from '../utils';
import { filterKnownHMSErrors, filterUncountedHMSErrors, HMSErrorModal } from '../../components/HMSErrorModal';
import { isHiddenFault, setHiddenCodes } from '../../hyyz17200/hiddenFaults';
import { hyyz17200NavItems } from '../../hyyz17200/nav';
import { hyyz17200Routes } from '../../hyyz17200/routes';
import { defaultNavItems } from '../../components/Layout';
import type { HMSError } from '../../api/client';

const BMCU_A = '0500040000010044';

const fault = (full_code: string): HMSError => ({
  code: '0x0',
  attr: 0,
  module: 5,
  severity: 1,
  full_code,
  description: `Fault ${full_code}`,
});

afterEach(() => {
  setHiddenCodes([]);
  cleanup();
});

describe('isHiddenFault', () => {
  it('hides nothing by default', () => {
    expect(isHiddenFault({ full_code: BMCU_A })).toBe(false);
    expect(isHiddenFault({})).toBe(false);
  });

  it('matches a 16-digit entry exactly', () => {
    setHiddenCodes([BMCU_A]);
    expect(isHiddenFault({ full_code: BMCU_A.toLowerCase() })).toBe(true);
    expect(isHiddenFault({ full_code: '0501040000010044' })).toBe(false);
    expect(isHiddenFault({ full_code: '05000044' })).toBe(false);
  });

  it('lets an 8-digit entry cover the hms[] form too', () => {
    setHiddenCodes(['05004004']);
    expect(isHiddenFault({ full_code: '05004004' })).toBe(true);
    expect(isHiddenFault({ full_code: '0500030000024004' })).toBe(true);
    expect(isHiddenFault({ full_code: '0500030000024005' })).toBe(false);
  });
});

describe('setHiddenCodes', () => {
  it('reports whether the set changed', () => {
    expect(setHiddenCodes([BMCU_A])).toBe(true);
    expect(setHiddenCodes([BMCU_A])).toBe(false);
    expect(setHiddenCodes(['05004004'])).toBe(true);
    expect(setHiddenCodes([])).toBe(true);
  });
});

describe('the mount in HMSErrorModal', () => {
  const bmcu = fault(BMCU_A);
  const real = fault('0700700000020001');

  it('stops a hidden fault counting, even one with actions', () => {
    setHiddenCodes([BMCU_A, '05004004']);
    const busy = { ...fault('05004004'), actions: ['OK_BUTTON'] };

    expect(filterKnownHMSErrors([bmcu, busy, real])).toEqual([real]);
    expect(filterUncountedHMSErrors([bmcu, busy, real])).toEqual([bmcu, busy]);
  });

  it('keeps a hidden fault listed in the modal, with the clear button', () => {
    setHiddenCodes([BMCU_A]);

    render(
      <HMSErrorModal printerName="P1" errors={[bmcu]} onClose={() => {}} printerId={1} hasPermission={() => true} />,
    );

    expect(screen.getByTestId('hms-uncounted').textContent).toContain('0500-0400-0001-0044');
    expect(screen.getByRole('button', { name: /clear/i })).toBeTruthy();
  });
});

describe('the page mounts', () => {
  it('adds the page to the sidebar and the routes', () => {
    expect(defaultNavItems.map((item) => item.id)).toContain(hyyz17200NavItems[0].id);
    expect(hyyz17200Routes.map((route) => `/${route.props.path}`)).toContain(hyyz17200NavItems[0].to);
  });
});
