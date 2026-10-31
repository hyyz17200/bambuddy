import { BellOff, type LucideIcon } from 'lucide-react';

/** The fork's sidebar entries; Layout adds them just above Settings. */
export const hyyz17200NavItems: { id: string; to: string; icon: LucideIcon; labelKey: string }[] = [
  { id: 'hyyz17200-hidden-faults', to: '/hyyz17200/hidden-faults', icon: BellOff, labelKey: 'hyyz17200.hiddenFaults.nav' },
];
