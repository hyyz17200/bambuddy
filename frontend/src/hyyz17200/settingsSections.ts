import type { ComponentType } from 'react';
import { BellOff, LayoutGrid, Palette, type LucideIcon } from 'lucide-react';
import { HiddenFaultsSection } from './HiddenFaultsSection';
import { QuickColorsSection } from './QuickColorsSection';
import { WideGridSection } from './WideGridSection';

/** The Enhanced Settings page's tabs, in rail order; the first opens by default.
 *  A patch with settings adds its tab here. Its stored values, if any, go
 *  through the backend's enhanced_settings.SECTIONS. */
export const enhancedSettingsSections: {
  id: string;
  icon: LucideIcon;
  titleKey: string;
  Component: ComponentType;
}[] = [
  { id: 'hidden-faults', icon: BellOff, titleKey: 'hyyz17200.hiddenFaults.title', Component: HiddenFaultsSection },
  { id: 'wide-grid', icon: LayoutGrid, titleKey: 'hyyz17200.wideGrid.title', Component: WideGridSection },
  { id: 'quick-colors', icon: Palette, titleKey: 'hyyz17200.quickColors.title', Component: QuickColorsSection },
];
