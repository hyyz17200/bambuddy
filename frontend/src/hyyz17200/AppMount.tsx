import { EnhancedSettingsSync } from './EnhancedSettingsSync';
import { HiddenFaultsSync } from './HiddenFaultsSync';

/** What the fork keeps running on every page, the full-page /camwall included:
 *  App.tsx renders it once, outside the router. */
export function Hyyz17200AppMount() {
  return (
    <>
      <HiddenFaultsSync />
      <EnhancedSettingsSync />
    </>
  );
}
