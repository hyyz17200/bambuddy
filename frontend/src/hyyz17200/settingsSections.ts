import type { ComponentType } from 'react';
import {
  AppWindow,
  BellOff,
  Camera,
  ClipboardCheck,
  FileCog,
  HardDrive,
  Layers,
  LayoutGrid,
  Palette,
  Repeat,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { AutoUnloadSection } from './AutoUnloadSection';
import { CamWallSection } from './CamWallSection';
import { HiddenFaultsSection } from './HiddenFaultsSection';
import { MaintenanceSection } from './maintenanceJob/MaintenanceSection';
import { PlateClearSection } from './PlateClearSection';
import { PlateCountSection } from './plateCount/PlateCountSection';
import { QuickColorsSection } from './QuickColorsSection';
import { SdReuseSection } from './SdReuseSection';
import { SlotPreferenceSection } from './SlotPreferenceSection';
import { TabTitleSection } from './tabTitle/TabTitleSection';
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
  { id: 'cam-wall', icon: Camera, titleKey: 'hyyz17200.camWall.settings.title', Component: CamWallSection },
  { id: 'tab-title', icon: AppWindow, titleKey: 'hyyz17200.tabTitle.title', Component: TabTitleSection },
  { id: 'quick-colors', icon: Palette, titleKey: 'hyyz17200.quickColors.title', Component: QuickColorsSection },
  { id: 'auto-unload', icon: Undo2, titleKey: 'hyyz17200.autoUnload.title', Component: AutoUnloadSection },
  { id: 'slot-preference', icon: Repeat, titleKey: 'hyyz17200.slotPreference.title', Component: SlotPreferenceSection },
  { id: 'maintenance', icon: FileCog, titleKey: 'hyyz17200.maintenance.settings.title', Component: MaintenanceSection },
  { id: 'plate-clear', icon: ClipboardCheck, titleKey: 'hyyz17200.plateClear.title', Component: PlateClearSection },
  { id: 'plate-count', icon: Layers, titleKey: 'hyyz17200.plateCount.settings.title', Component: PlateCountSection },
  { id: 'sd-reuse', icon: HardDrive, titleKey: 'hyyz17200.sdReuse.title', Component: SdReuseSection },
];
