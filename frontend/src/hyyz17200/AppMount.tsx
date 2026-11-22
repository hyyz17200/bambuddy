import { EnhancedSettingsSync } from './EnhancedSettingsSync';
import { HiddenFaultsSync } from './HiddenFaultsSync';
import { Hyyz17200FloatingSelect } from './quickButtons/QuickButtons';
import { SliceAsDesignedPanel } from './sliceAsDesigned/SliceAsDesignedPanel';
import { TabTitleSync } from './tabTitle/TabTitleSync';

/** What the fork keeps running on every page, the full-page /camwall included:
 *  App.tsx renders it once, outside the router. */
export function Hyyz17200AppMount() {
  return (
    <>
      <HiddenFaultsSync />
      <EnhancedSettingsSync />
      <SliceAsDesignedPanel />
      <TabTitleSync />
      <Hyyz17200FloatingSelect />
    </>
  );
}
